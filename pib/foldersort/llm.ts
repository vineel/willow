// LLM-driven folder selection. Calls LM Studio (Gemma) with an
// enum-constrained schema so the model literally cannot emit a folder name
// that isn't in the catalog. Conservative-default bias is built into the
// prompt — when in doubt, leave_in_inbox.

import { chatCompletion, healthCheck } from "../../memory/lmstudio/client";
import { createLogger } from "../logger";
import type { CanonicalEvent } from "../jmap/types";
import type { FolderProfile } from "./types";
import { LEAVE_IN_INBOX } from "./types";

const log = createLogger("foldersort.llm");

const SYSTEM_PROMPT = [
  "You are an email sorting agent for Vineel. You decide which folder each incoming email belongs in.",
  "Vineel wants you to be conservative: when in doubt, choose leave_in_inbox.",
  "The inbox is for important and uncategorized mail; it is correct to leave a lot of mail there.",
  "Pick a non-inbox folder only when the email clearly matches that folder's description.",
  "Respond with JSON only.",
].join(" ");

// Used only as a fallback retry after the primary call times out. Explicitly
// discourages the step-by-step "is it X? is it Y?" reasoning pattern that
// drives some responses past 800+ reasoning tokens before ever reaching an
// answer — this variant trades a little accuracy for actually finishing.
const TERSE_SYSTEM_PROMPT = [
  "You are an email sorting agent for Vineel. You decide which folder each incoming email belongs in.",
  "Be conservative: when in doubt, choose leave_in_inbox.",
  "Do NOT reason through every folder option one by one. Pick the single best match immediately from the sender/subject/domain, in one short phrase, then answer.",
  "Respond with JSON only.",
].join(" ");

export interface LLMDecision {
  selected_folder: string;
  reason: string;
}

export interface LLMOptions {
  isKnownCorrespondent?: boolean;  // hint for people-i-dont-know reasoning
  // Batch/sweep mode: skip the primary (thorough) prompt entirely and go
  // straight to the terse one. For a live single email the thorough prompt
  // usually succeeds fine and is worth the wait; for a large backlog sweep
  // the 120s primary attempt is a near-guaranteed waste of time per item
  // (see TERSE_SYSTEM_PROMPT) — just take the faster, slightly-less-careful
  // answer for all of them.
  terseOnly?: boolean;
}

function formatProfileLines(profiles: FolderProfile[]): string {
  const lines: string[] = [];
  lines.push(`${LEAVE_IN_INBOX}: keep in the main inbox; the safe default`);
  for (const p of profiles) {
    lines.push(`${p.name}: ${p.description}`);
  }
  return lines.join("\n");
}

function buildPrompt(event: CanonicalEvent, profiles: FolderProfile[], opts: LLMOptions): string {
  const fromDomain = event.fromEntity.address.split("@")[1] ?? "";
  const bodyPreview = (event.bodyText ?? "").slice(0, 800);

  const hintsBlock = profiles
    .filter((p) => p.llm_hint)
    .map((p) => `[${p.name}] ${p.llm_hint}`)
    .join("\n");

  const correspondentHint = opts.isKnownCorrespondent === undefined
    ? ""
    : `\nKNOWN CORRESPONDENT: ${opts.isKnownCorrespondent ? "yes — Vineel has emailed this sender recently. Strong signal to leave_in_inbox even if the email looks otherwise sortable." : "no — Vineel has NOT emailed this sender recently. Combined with individual-looking sender signals, consider people-i-dont-know."}\n`;

  return `Classify this email into exactly one of the folders below.

EMAIL:
From: ${event.fromEntity.displayName} <${event.fromEntity.address}>
Domain: ${fromDomain}
Subject: ${event.subject ?? "(no subject)"}
Body:
${bodyPreview}
${correspondentHint}
FOLDERS (pick exactly one, including ${LEAVE_IN_INBOX}):
${formatProfileLines(profiles)}

ADDITIONAL FOLDER HINTS:
${hintsBlock || "(none)"}

Return JSON: {"selected_folder": "<name>", "reason": "<one short sentence>"}.
If you are unsure, return ${LEAVE_IN_INBOX}.`;
}

// Shorter variant for the terse retry: drops the per-folder llm_hint block
// (the main driver of long enumeration) and trims the body preview further.
function buildTersePrompt(event: CanonicalEvent, profiles: FolderProfile[], opts: LLMOptions): string {
  const fromDomain = event.fromEntity.address.split("@")[1] ?? "";
  const bodyPreview = (event.bodyText ?? "").slice(0, 300);

  const correspondentHint = opts.isKnownCorrespondent === undefined
    ? ""
    : `\nKnown correspondent: ${opts.isKnownCorrespondent ? "yes — lean leave_in_inbox." : "no."}\n`;

  return `Classify this email into exactly one folder. Answer immediately, no per-folder walkthrough.

From: ${event.fromEntity.displayName} <${event.fromEntity.address}>
Domain: ${fromDomain}
Subject: ${event.subject ?? "(no subject)"}
Body: ${bodyPreview}
${correspondentHint}
FOLDERS:
${formatProfileLines(profiles)}

JSON only: {"selected_folder": "<name>", "reason": "<≤10 words>"}. Unsure → ${LEAVE_IN_INBOX}.`;
}

export async function decideViaLLM(
  event: CanonicalEvent,
  profiles: FolderProfile[],
  opts: LLMOptions = {}
): Promise<LLMDecision | null> {
  const enabled = profiles.filter((p) => p.enabled);
  if (enabled.length === 0) {
    log.warn("No enabled profiles; returning null (caller should default to leave_in_inbox)");
    return null;
  }

  const enumValues = [LEAVE_IN_INBOX, ...enabled.map((p) => p.name)];

  const schema = {
    name: "folder_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        selected_folder: { type: "string", enum: enumValues },
        reason: { type: "string" },
      },
      required: ["selected_folder", "reason"],
      additionalProperties: false,
    },
  };

  const available = await healthCheck();
  if (!available) {
    log.warn("LM Studio unavailable; returning null");
    return null;
  }

  const verify = (parsed: unknown): LLMDecision => {
    const d = parsed as LLMDecision;
    if (!enumValues.includes(d.selected_folder)) {
      log.warn(`LLM returned out-of-enum value "${d.selected_folder}"; falling back to ${LEAVE_IN_INBOX}`);
      return { selected_folder: LEAVE_IN_INBOX, reason: "fallback: LLM returned invalid folder" };
    }
    return d;
  };

  if (opts.terseOnly) {
    try {
      const { parsed } = await chatCompletion(
        [
          { role: "system", content: TERSE_SYSTEM_PROMPT },
          { role: "user", content: buildTersePrompt(event, enabled, opts) },
        ],
        { jsonSchema: schema, temperature: 0.1, timeoutMs: 60_000, maxTokens: 1200 }
      );
      return verify(parsed);
    } catch (err) {
      log.error(`Terse-only decision failed: ${(err as Error).message}`);
      return null;
    }
  }

  try {
    const { parsed } = await chatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(event, enabled, opts) },
      ],
      { jsonSchema: schema, temperature: 0.1, timeoutMs: 120_000 }
    );
    return verify(parsed);
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`LLM decision failed: ${msg}`);
    if (!msg.includes("timed out")) return null;

    // Primary call timed out (likely stuck in a long per-folder reasoning
    // chain — see TERSE_SYSTEM_PROMPT comment). One quick terse retry before
    // giving up, rather than losing the email to leave_in_inbox outright.
    log.warn("Primary call timed out; retrying with terse prompt");
    try {
      const { parsed } = await chatCompletion(
        [
          { role: "system", content: TERSE_SYSTEM_PROMPT },
          { role: "user", content: buildTersePrompt(event, enabled, opts) },
        ],
        { jsonSchema: schema, temperature: 0.1, timeoutMs: 60_000, maxTokens: 1200 }
      );
      const d = verify(parsed);
      log.info(`Terse retry succeeded: ${d.selected_folder}`);
      return d;
    } catch (retryErr) {
      log.error(`Terse retry also failed: ${(retryErr as Error).message}`);
      return null;
    }
  }
}
