// Orchestrator: rules → LLM → default. The single entry point used by the
// pipeline, the backfill CLI, the dry-run CLI, and the preview_inbox_sort
// MCP tool.

import type { CanonicalEvent } from "../jmap/types";
import { loadActiveRules, matchRules } from "./rules";
import { listProfiles } from "./profiles";
import { decideViaLLM } from "./llm";
import { isKnownCorrespondent } from "./correspondents";
import { LEAVE_IN_INBOX } from "./types";
import type { FolderDecision, FolderProfile, FolderRule } from "./types";

export interface DecideContext {
  // Pre-loaded for batch callers; the orchestrator loads them itself if absent.
  profiles?: FolderProfile[];
  rules?: FolderRule[];
}

export async function decide(
  event: CanonicalEvent,
  ctx: DecideContext = {}
): Promise<FolderDecision> {
  const profiles = ctx.profiles ?? (await listProfiles(true));   // include disabled so reasoning can mention them; LLM filters again
  const rules = ctx.rules ?? (await loadActiveRules());

  // 1) Deterministic rules first.
  const ruleHit = matchRules(event, rules);
  if (ruleHit) {
    return {
      target: ruleHit.target_folder,
      decided_by: "rule",
      rule_id: ruleHit.id,
      reason: `rule:${ruleHit.name}`,
    };
  }

  // 2) LLM judgment. Pre-compute the correspondent signal for the prompt.
  const known = await isKnownCorrespondent(event.fromEntity.address);
  const llm = await decideViaLLM(event, profiles, { isKnownCorrespondent: known });

  if (llm) {
    return {
      target: llm.selected_folder,
      decided_by: "llm",
      rule_id: null,
      reason: llm.reason,
    };
  }

  // 3) Default — leave in inbox (safe).
  return {
    target: LEAVE_IN_INBOX,
    decided_by: "default",
    rule_id: null,
    reason: "no rule match; LLM unavailable or failed",
  };
}
