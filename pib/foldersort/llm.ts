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

export interface LLMDecision {
  selected_folder: string;
  reason: string;
}

export interface LLMOptions {
  isKnownCorrespondent?: boolean;  // hint for people-i-dont-know reasoning
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

  try {
    const { parsed } = await chatCompletion(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(event, enabled, opts) },
      ],
      { jsonSchema: schema, temperature: 0.1, timeoutMs: 60_000 }
    );
    const d = parsed as LLMDecision;
    // Defense in depth: although schema is enum-constrained, verify.
    if (!enumValues.includes(d.selected_folder)) {
      log.warn(`LLM returned out-of-enum value "${d.selected_folder}"; falling back to ${LEAVE_IN_INBOX}`);
      return { selected_folder: LEAVE_IN_INBOX, reason: "fallback: LLM returned invalid folder" };
    }
    return d;
  } catch (err) {
    log.error(`LLM decision failed: ${(err as Error).message}`);
    return null;
  }
}
