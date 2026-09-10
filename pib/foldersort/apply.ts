// Apply a foldersort decision: move the email via JMAP (if appropriate) and
// stamp folder_applied_at on the fact. Shared by pipeline step 8, the
// backfill CLI, and the MCP correct_placement tool.
//
// Auto-apply is gated by WILLOW_FOLDERSORT_APPLY (default "1" = on).
// Set WILLOW_FOLDERSORT_APPLY=0 to fall back to proposal-only.

import { sql } from "../config";
import { moveEmail } from "../jmap/mutate";
import { createLogger } from "../logger";
import { LEAVE_IN_INBOX, type FolderDecision, type FolderProfile } from "./types";
import type { JMAPSession } from "../jmap/types";

const log = createLogger("foldersort.apply");

export function shouldAutoApply(): boolean {
  const v = process.env.WILLOW_FOLDERSORT_APPLY;
  if (v === undefined) return true;
  return v === "1" || v.toLowerCase() === "true";
}

export interface ApplyContext {
  session: JMAPSession;
  token: string;
  inboxMailboxId: string;
  profilesByName: Map<string, FolderProfile>;
}

export interface ApplyResult {
  applied: boolean;          // true if folder_applied_at was set (incl. no-op leave_in_inbox)
  moved: boolean;            // true if a JMAP move was performed
  error: string | null;
}

/**
 * Write the proposal AND optionally apply the move. Always writes
 * folder_target/decided_by/reason/proposed_at. Sets folder_applied_at only
 * when auto-apply is on AND the move succeeds (or no move is needed).
 */
export async function applyDecision(
  factId: string,
  jmapEmailId: string,
  decision: FolderDecision,
  ctx: ApplyContext
): Promise<ApplyResult> {
  const auto = shouldAutoApply();

  // Always record the proposal.
  await sql`
    UPDATE app.fact SET
      folder_target      = ${decision.target},
      folder_decided_by  = ${decision.decided_by},
      folder_rule_id     = ${decision.rule_id},
      folder_reason      = ${decision.reason},
      folder_proposed_at = now(),
      folder_applied_at  = NULL,
      folder_error       = NULL
    WHERE fact_id = ${factId}
  `;

  if (!auto) return { applied: false, moved: false, error: null };

  // leave_in_inbox is a no-op move. Stamp applied so digest/preview filters work cleanly.
  if (decision.target === LEAVE_IN_INBOX) {
    await sql`
      UPDATE app.fact SET folder_applied_at = now() WHERE fact_id = ${factId}
    `;
    return { applied: true, moved: false, error: null };
  }

  const profile = ctx.profilesByName.get(decision.target);
  if (!profile) {
    const err = `target profile "${decision.target}" not in profiles map`;
    log.error(`fact ${factId.slice(0, 8)}: ${err}`);
    await sql`UPDATE app.fact SET folder_error = ${err} WHERE fact_id = ${factId}`;
    return { applied: false, moved: false, error: err };
  }
  if (!profile.mailbox_id) {
    const err = `target profile "${decision.target}" has no cached mailbox_id; run foldersort:bootstrap`;
    log.error(`fact ${factId.slice(0, 8)}: ${err}`);
    await sql`UPDATE app.fact SET folder_error = ${err} WHERE fact_id = ${factId}`;
    return { applied: false, moved: false, error: err };
  }

  try {
    await moveEmail(ctx.session, ctx.token, jmapEmailId, profile.mailbox_id, ctx.inboxMailboxId);
    await sql`
      UPDATE app.fact SET folder_applied_at = now() WHERE fact_id = ${factId}
    `;
    return { applied: true, moved: true, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`fact ${factId.slice(0, 8)} move failed: ${msg}`);
    await sql`UPDATE app.fact SET folder_error = ${msg} WHERE fact_id = ${factId}`;
    return { applied: false, moved: false, error: msg };
  }
}
