// JMAP mutations. Currently exposes moveEmail(); future: deleteEmail(),
// updateKeywords(), etc.

import type { JMAPSession } from "./types";
import { jmapRequest } from "./client";

export interface MoveResult {
  emailId: string;
  addedTo: string;
  removedFrom: string | null;
}

/**
 * Move an email between mailboxes via Email/set patch.
 *
 * Uses JMAP patch syntax (`mailboxIds/<id>: true|null`) so other mailbox
 * memberships (labels, etc.) on the same email are preserved. Pass
 * removeFromMailboxId=null to "add to a folder without removing from any" —
 * useful for labels.
 */
export async function moveEmail(
  session: JMAPSession,
  token: string,
  emailId: string,
  addToMailboxId: string,
  removeFromMailboxId: string | null
): Promise<MoveResult> {
  const patch: Record<string, unknown> = {
    [`mailboxIds/${addToMailboxId}`]: true,
  };
  if (removeFromMailboxId && removeFromMailboxId !== addToMailboxId) {
    patch[`mailboxIds/${removeFromMailboxId}`] = null;
  }

  const resp = await jmapRequest(session.apiUrl, token, [
    [
      "Email/set",
      {
        accountId: session.accountId,
        update: { [emailId]: patch },
      },
      "m1",
    ],
  ]);

  const [method, result] = resp.methodResponses[0];
  if (method === "error") {
    throw new Error(`Email/set failed: ${JSON.stringify(result)}`);
  }
  const updated = (result as any).updated as Record<string, unknown> | undefined;
  const notUpdated = (result as any).notUpdated as Record<string, unknown> | undefined;
  if (notUpdated && notUpdated[emailId]) {
    throw new Error(`Email/set notUpdated for ${emailId}: ${JSON.stringify(notUpdated[emailId])}`);
  }
  if (!updated || !(emailId in updated)) {
    throw new Error(`Email/set did not confirm update of ${emailId}: ${JSON.stringify(result)}`);
  }

  return { emailId, addedTo: addToMailboxId, removedFrom: removeFromMailboxId };
}
