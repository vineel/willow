#!/usr/bin/env bun
/**
 * MCP server for the foldersort agent. Exposes tools to manage folder
 * profiles, deterministic rules, the correspondent list, and to preview /
 * correct sort proposals — all from conversational chat with Willow.
 *
 * All logging MUST go to stderr (stdout is MCP stdio).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sql } from "../../pib/config";
import { getSecret } from "../../pib/config";
import { getSession, getMailboxes } from "../../pib/jmap/session";
import { getEmails } from "../../pib/jmap/query";
import { normalize } from "../../pib/normalizer";
import { moveEmail } from "../../pib/jmap/mutate";
import { LEAVE_IN_INBOX } from "../../pib/foldersort/types";
import {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  disableProfile,
  appendExampleSender,
  appendExampleSubject,
} from "../../pib/foldersort/profiles";
import {
  listFolderRules,
  addFolderRule,
  disableFolderRule,
} from "../../pib/foldersort/rules";
import {
  addCorrespondent,
  removeCorrespondent,
  listCorrespondents,
} from "../../pib/foldersort/correspondents";
import { decide } from "../../pib/foldersort/decide";
import { sourceNoteToEvent } from "../../pib/foldersort/from-source-note";
import { formatPreviewItem, formatPreviewList, type PreviewItem } from "../../pib/foldersort/format";
import type { FolderDecision } from "../../pib/foldersort/types";

const FASTMAIL_URL_RE = /\/mail\/[^/]+\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/;
function emailIdFromUrl(u: string): string | null {
  const m = FASTMAIL_URL_RE.exec(u);
  return m ? m[2] : null;
}

// Cache the JMAP session + inbox id for move-back operations during correct_placement.
let cachedSession: Awaited<ReturnType<typeof getSession>> | null = null;
let cachedToken: string | null = null;
let cachedInboxId: string | null = null;
async function getJmapContext(): Promise<{ session: NonNullable<typeof cachedSession>; token: string; inboxId: string }> {
  if (cachedSession && cachedToken && cachedInboxId) {
    return { session: cachedSession, token: cachedToken, inboxId: cachedInboxId };
  }
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const inbox = mailboxes.find((m) => m.role === "inbox");
  if (!inbox) throw new Error("inbox mailbox not found");
  cachedSession = session; cachedToken = token; cachedInboxId = inbox.id;
  return { session, token, inboxId: inbox.id };
}

async function loadFactRow(refLike: string) {
  // Accept full uuid or short prefix (e.g. "e491").
  const rows = (await sql`
    SELECT f.fact_id, f.folder_target, f.folder_decided_by, f.folder_rule_id,
           f.folder_reason, f.folder_proposed_at, f.folder_applied_at,
           sn.source_note_id, sn.source_type, sn.source_ref, sn.title,
           sn.raw_text, sn.metadata, sn.received_at
    FROM app.fact f
    JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
    WHERE f.fact_id::text LIKE ${refLike + "%"}
    ORDER BY f.created_at DESC
    LIMIT 2
  `) as unknown as any[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`Ambiguous fact reference "${refLike}" — try the full uuid`);
  return rows[0];
}

const server = new McpServer(
  { name: "willow-foldersort", version: "0.1.0" },
  {
    instructions: [
      "Foldersort moves emails out of the inbox into subfolders of willow-secondary.",
      "Phase 1 is PROPOSAL-ONLY: the pipeline writes proposed targets to the DB but does NOT move mail.",
      "Use preview_inbox_sort to show recent proposals as compact chat blocks; user can correct via correct_placement.",
      "Use create_profile/update_profile when the user describes a folder's purpose.",
      "Use add_folder_rule for deterministic 'always put X in Y' rules; add_folder_rule_from_url is the most ergonomic.",
      "Use add_correspondent when the user says 'I know X now' — moves X into the known-correspondents whitelist.",
    ].join(" "),
  }
);

// ---------- Profiles ----------

server.tool(
  "list_profiles",
  "List all folder profiles (enabled and disabled). Shows description, llm_hint, and example counts per profile.",
  {
    include_disabled: z.boolean().optional().default(true),
  },
  async ({ include_disabled }) => {
    const ps = await listProfiles(include_disabled);
    const lines = ps.map(
      (p) =>
        `${p.enabled ? "•" : "○"} ${p.name}${p.enabled ? "" : " (disabled)"}` +
        `\n    desc: ${p.description}` +
        (p.llm_hint ? `\n    hint: ${p.llm_hint}` : "") +
        `\n    senders: ${p.example_senders.length}  subjects: ${p.example_subjects.length}`
    );
    return { content: [{ type: "text", text: `${ps.length} profiles:\n\n${lines.join("\n\n")}` }] };
  }
);

server.tool(
  "create_profile",
  "Create a new folder profile. Use when the user describes a new folder, e.g. 'I made a folder called Receipts; it's for order confirmations'.",
  {
    name: z.string().describe("Subfolder name under willow-secondary; must match the Fastmail folder exactly"),
    description: z.string().describe("One-line description shown to the LLM during folder selection"),
    llm_hint: z.string().optional().describe("Longer guidance for the LLM"),
    example_senders: z.array(z.string()).optional(),
    example_subjects: z.array(z.string()).optional(),
  },
  async ({ name, description, llm_hint, example_senders, example_subjects }) => {
    const existing = await getProfile(name);
    if (existing) {
      return { content: [{ type: "text", text: `Profile "${name}" already exists — use update_profile to edit it.` }] };
    }
    const p = await createProfile({ name, description, llm_hint, example_senders, example_subjects });
    return { content: [{ type: "text", text: `Created profile "${p.name}" (enabled=${p.enabled}).` }] };
  }
);

server.tool(
  "update_profile",
  "Update an existing profile's description, llm_hint, or enabled flag.",
  {
    name: z.string(),
    description: z.string().optional(),
    llm_hint: z.string().nullable().optional().describe("Pass null to clear"),
    enabled: z.boolean().optional(),
  },
  async ({ name, description, llm_hint, enabled }) => {
    const p = await updateProfile(name, { description, llm_hint, enabled });
    if (!p) return { content: [{ type: "text", text: `Profile "${name}" not found.` }] };
    return { content: [{ type: "text", text: `Updated profile "${p.name}".` }] };
  }
);

server.tool(
  "disable_profile",
  "Disable a profile so the LLM no longer considers it as a target.",
  { name: z.string() },
  async ({ name }) => {
    const ok = await disableProfile(name);
    return { content: [{ type: "text", text: ok ? `Disabled "${name}".` : `Profile "${name}" not found.` }] };
  }
);

// ---------- Rules ----------

server.tool(
  "list_folder_rules",
  "List folder rules. Optionally filter by target folder.",
  { target_folder: z.string().optional() },
  async ({ target_folder }) => {
    const rs = await listFolderRules(target_folder);
    if (rs.length === 0) return { content: [{ type: "text", text: "No rules." }] };
    const lines = rs.map(
      (r) =>
        `${r.enabled ? "•" : "○"} [${r.priority}] (${r.source}) ${r.field} ${r.operator} ${r.value ?? ""} → ${r.target_folder}` +
        `\n    id: ${r.id}  name: ${r.name}`
    );
    return { content: [{ type: "text", text: `${rs.length} rules:\n\n${lines.join("\n\n")}` }] };
  }
);

server.tool(
  "add_folder_rule",
  "Add a deterministic folder rule. Use for clear 'always put X in Y' patterns. Lower priority = evaluated first; default 100.",
  {
    name: z.string().describe("Human-readable rule name"),
    field: z.enum(["from_address", "from_domain", "subject", "header", "source_type"]),
    operator: z.enum(["equals", "contains", "starts_with", "ends_with", "regex", "exists", "gte"]),
    value: z.string().optional(),
    header_name: z.string().optional(),
    target_folder: z.string().describe("Profile name (must exist)"),
    priority: z.number().optional(),
  },
  async (args) => {
    const target = await getProfile(args.target_folder);
    if (!target) return { content: [{ type: "text", text: `Target folder "${args.target_folder}" does not exist as a profile.` }] };
    const r = await addFolderRule({ ...args, source: "user", confirmed: true });
    return { content: [{ type: "text", text: `Added rule "${r.name}" (${r.id}) → ${r.target_folder} at priority ${r.priority}.` }] };
  }
);

server.tool(
  "add_folder_rule_from_url",
  "Fetch a Fastmail email by URL and create a rule from its sender or subject. The most ergonomic way to teach the system: 'put emails like this one into folder X'.",
  {
    url: z.string().describe("Fastmail web URL of a representative email"),
    target_folder: z.string(),
    kind: z.enum(["sender", "domain", "subject_contains"]).describe("What attribute to pattern on"),
  },
  async ({ url, target_folder, kind }) => {
    const target = await getProfile(target_folder);
    if (!target) return { content: [{ type: "text", text: `Target folder "${target_folder}" does not exist.` }] };
    const emailId = emailIdFromUrl(url);
    if (!emailId) return { content: [{ type: "text", text: `Could not parse Fastmail URL.` }] };
    const token = await getSecret("fastmail-token");
    const session = await getSession(token);
    const emails = await getEmails(session, token, [emailId]);
    if (emails.length === 0) return { content: [{ type: "text", text: `Email not found at ${url}` }] };
    const e = emails[0];
    const from = e.from?.[0]?.email?.toLowerCase() ?? "";
    const domain = from.split("@")[1] ?? "";
    const subject = e.subject ?? "";
    let field: string, operator: string, value: string, name: string;
    if (kind === "sender") {
      if (!from) return { content: [{ type: "text", text: "Email has no from-address." }] };
      field = "from_address"; operator = "equals"; value = from;
      name = `user:from_address:${from}->${target_folder}`;
    } else if (kind === "domain") {
      if (!domain) return { content: [{ type: "text", text: "Email has no domain." }] };
      field = "from_domain"; operator = "equals"; value = domain;
      name = `user:from_domain:${domain}->${target_folder}`;
    } else {
      if (!subject) return { content: [{ type: "text", text: "Email has no subject." }] };
      field = "subject"; operator = "contains"; value = subject.slice(0, 60);
      name = `user:subject_contains:${value}->${target_folder}`;
    }
    const r = await addFolderRule({ name, field, operator, value, target_folder, priority: 5, source: "user", confirmed: true });
    return { content: [{ type: "text", text: `Added rule "${r.name}" (${r.id}): ${field} ${operator} "${value}" → ${target_folder}` }] };
  }
);

server.tool(
  "disable_folder_rule",
  "Disable a folder rule by id.",
  { id: z.string() },
  async ({ id }) => {
    const ok = await disableFolderRule(id);
    return { content: [{ type: "text", text: ok ? `Disabled rule ${id}.` : `Rule ${id} not found.` }] };
  }
);

// ---------- Preview / dry-run / correct ----------

server.tool(
  "preview_inbox_sort",
  "Show recent foldersort proposals as compact chat-formatted blocks (one per email). Users can then say 'change #N to FOLDER' and the agent calls correct_placement on the underlying fact_id. Default 20.",
  {
    count: z.number().optional().default(20),
  },
  async ({ count }) => {
    const rows = (await sql`
      SELECT f.fact_id, f.folder_target, f.folder_decided_by, f.folder_rule_id,
             f.folder_reason, sn.source_note_id, sn.source_type, sn.source_ref,
             sn.title, sn.raw_text, sn.metadata, sn.received_at
      FROM app.fact f
      JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
      WHERE f.folder_proposed_at IS NOT NULL
        AND f.folder_applied_at IS NULL
      ORDER BY f.folder_proposed_at DESC
      LIMIT ${count}
    `) as unknown as any[];
    if (rows.length === 0) {
      return { content: [{ type: "text", text: "No pending proposals. Run `foldersort:backfill` to populate." }] };
    }
    const items: PreviewItem[] = rows.map((r) => {
      const event = sourceNoteToEvent(r);
      const decision: FolderDecision = {
        target: r.folder_target,
        decided_by: r.folder_decided_by,
        rule_id: r.folder_rule_id,
        reason: r.folder_reason ?? "",
      };
      return { factId: r.fact_id, event, decision, receivedAt: event.receivedAt };
    });
    return { content: [{ type: "text", text: formatPreviewList(items) }] };
  }
);

server.tool(
  "test_foldersort",
  "Dry-run the foldersort decision on a specific email. Accepts a Fastmail URL, a JMAP email id, or a fact_id (short prefix ok).",
  {
    url: z.string().optional(),
    id: z.string().optional(),
    fact_id: z.string().optional(),
  },
  async ({ url, id, fact_id }) => {
    let event, factId;
    if (fact_id) {
      const row = await loadFactRow(fact_id);
      if (!row) return { content: [{ type: "text", text: `fact_id ${fact_id} not found.` }] };
      event = sourceNoteToEvent(row); factId = row.fact_id;
    } else {
      const emailId = id ?? (url ? emailIdFromUrl(url) : null);
      if (!emailId) return { content: [{ type: "text", text: "Provide url, id, or fact_id." }] };
      const token = await getSecret("fastmail-token");
      const session = await getSession(token);
      const emails = await getEmails(session, token, [emailId]);
      if (emails.length === 0) return { content: [{ type: "text", text: `Email ${emailId} not found.` }] };
      event = normalize(emails[0]); factId = "(live)";
    }
    const decision = await decide(event);
    return {
      content: [{
        type: "text",
        text: formatPreviewItem({ factId, event, decision, receivedAt: event.receivedAt }, 0),
      }],
    };
  }
);

server.tool(
  "correct_placement",
  "Apply a corrective placement: this email should have gone to TARGET_FOLDER, not where the system proposed. The MCP server runs a decision tree on the underlying fact: if a rule mis-fired, demote it; if it was an LLM call, append an example to the correct profile. ALSO rewrites the proposal to the corrected target so re-previewing shows the right answer.",
  {
    fact_ref: z.string().describe("fact_id (full uuid or short prefix like 'e491')"),
    target_folder: z.string().describe("Where this email actually belongs (must be an enabled profile, or 'leave_in_inbox')"),
    reason: z.string().optional(),
  },
  async ({ fact_ref, target_folder, reason }) => {
    const row = await loadFactRow(fact_ref);
    if (!row) return { content: [{ type: "text", text: `fact "${fact_ref}" not found.` }] };
    let targetProfile = null;
    if (target_folder !== LEAVE_IN_INBOX) {
      targetProfile = await getProfile(target_folder);
      if (!targetProfile) return { content: [{ type: "text", text: `Target folder "${target_folder}" doesn't exist as a profile.` }] };
    }
    const event = sourceNoteToEvent(row);
    const fromAddr = event.fromEntity.address;
    const subject = event.subject ?? "";

    const notes: string[] = [];

    // If the email was already moved, do the physical move-back/over first.
    if (row.folder_applied_at && row.folder_target && row.folder_target !== target_folder) {
      try {
        const { session, token, inboxId } = await getJmapContext();
        let removeFromId: string | null = null;
        if (row.folder_target !== LEAVE_IN_INBOX) {
          const sourceProfile = await getProfile(row.folder_target);
          removeFromId = sourceProfile?.mailbox_id ?? null;
          if (!removeFromId) {
            notes.push(`Warning: couldn't find source mailbox_id for "${row.folder_target}" — move-back may be incomplete.`);
          }
        }
        const addToId = targetProfile ? targetProfile.mailbox_id : inboxId;
        if (!addToId) {
          notes.push(`ERROR: target "${target_folder}" has no mailbox_id; cannot move. Run foldersort:bootstrap to refresh.`);
        } else {
          await moveEmail(session, token, row.source_ref, addToId, removeFromId);
          notes.push(`Moved email from ${row.folder_target} → ${target_folder} (JMAP).`);
        }
      } catch (err) {
        notes.push(`ERROR moving email: ${(err as Error).message}`);
      }
    } else if (!row.folder_applied_at) {
      notes.push("(Email had not yet been applied — proposal rewrite only, no JMAP move needed.)");
    }

    // Decision tree on the prior decision.
    if (row.folder_decided_by === "rule" && row.folder_rule_id) {
      await disableFolderRule(row.folder_rule_id);
      notes.push(`Disabled the mis-firing rule (id=${row.folder_rule_id}).`);
      if (target_folder !== LEAVE_IN_INBOX) {
        await appendExampleSender(target_folder, fromAddr);
        if (subject) await appendExampleSubject(target_folder, subject);
        notes.push(`Appended sender + subject to "${target_folder}" examples.`);
      }
    } else if (row.folder_decided_by === "llm" || row.folder_decided_by === "default") {
      if (target_folder !== LEAVE_IN_INBOX) {
        await appendExampleSender(target_folder, fromAddr);
        if (subject) await appendExampleSubject(target_folder, subject);
        notes.push(`Appended sender (${fromAddr}) + subject to "${target_folder}" examples.`);
        notes.push("(Auto-rule promotion after repeated corrections is a post-v0 feature; add a rule manually with add_folder_rule / add_folder_rule_from_url if this is a pattern.)");
      } else {
        notes.push("Marked as leave_in_inbox; no rule or profile mutation.");
      }
    }

    // Rewrite the proposal AND mark applied (the move-back above completed the apply).
    await sql`
      UPDATE app.fact SET
        folder_target = ${target_folder},
        folder_decided_by = 'manual',
        folder_rule_id = NULL,
        folder_reason = ${reason ?? "user correction"},
        folder_proposed_at = now(),
        folder_applied_at = now(),
        folder_error = NULL
      WHERE fact_id = ${row.fact_id}
    `;
    notes.push(`Updated fact ${row.fact_id.slice(0, 8)} → ${target_folder}.`);

    return { content: [{ type: "text", text: notes.join("\n") }] };
  }
);

// ---------- Correspondents ----------

server.tool(
  "add_correspondent",
  "Add an email address to the known-correspondent list ('I know X now'). The foldersort agent will treat mail from this address as from a known person.",
  {
    email: z.string(),
    note: z.string().optional(),
  },
  async ({ email, note }) => {
    const { inserted } = await addCorrespondent(email, note);
    return { content: [{ type: "text", text: inserted ? `Added ${email} to known correspondents.` : `${email} was already known; updated note/timestamp.` }] };
  }
);

server.tool(
  "remove_correspondent",
  "Remove an email from the correspondent list. Use for automation addresses that shouldn't grant trust.",
  { email: z.string() },
  async ({ email }) => {
    const ok = await removeCorrespondent(email);
    return { content: [{ type: "text", text: ok ? `Removed ${email}.` : `${email} not in list.` }] };
  }
);

server.tool(
  "list_correspondents",
  "List known correspondents, optionally filtered by a substring.",
  { contains: z.string().optional() },
  async ({ contains }) => {
    const rows = await listCorrespondents(contains);
    if (rows.length === 0) return { content: [{ type: "text", text: "(no correspondents matching)" }] };
    const lines = rows.map((r) => `${r.address}  [${r.source}]${r.note ? `  — ${r.note}` : ""}`);
    return { content: [{ type: "text", text: `${rows.length} correspondents:\n${lines.join("\n")}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
