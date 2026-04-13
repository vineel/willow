/**
 * Send a test digest for specific fact IDs (resets digest_sent_at, sends, then restores).
 * Also supports --last N to grab the N most recent digest items.
 *
 * Usage:
 *   bun run pib:digest:test -- --last 10
 *   bun run pib:digest:test -- id1 id2 id3
 */
import { sql, getSecret } from "../config";
import { groupDigestItems, getPendingDigestItems, formatDigestText, formatDigestHtml } from "../digest";
import { getSession, getMailboxes } from "../jmap/session";
import { sendNotification } from "../jmap/notify";

// Parse args
const args = process.argv.slice(2).filter((a) => a !== "--");
const lastIdx = args.indexOf("--last");
let factIds: string[];

if (lastIdx !== -1) {
  const n = parseInt(args[lastIdx + 1] ?? "10", 10);
  const rows = await sql`
    SELECT f.fact_id
    FROM app.fact f
    JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
    WHERE f.triage_action = 'digest' AND sn.source_type = 'email'
    ORDER BY sn.received_at DESC
    LIMIT ${n}
  `;
  factIds = rows.map((r) => r.fact_id);
  console.log(`Selected last ${factIds.length} digest items`);
} else {
  factIds = args.filter((a) => !a.startsWith("-"));
  if (factIds.length === 0) {
    console.log("Usage:");
    console.log("  bun run pib:digest:test -- --last 10");
    console.log("  bun run pib:digest:test -- <fact-id-1> <fact-id-2> ...");
    await sql.end();
    process.exit(1);
  }
}

// Temporarily clear digest_sent_at for these items
await sql`
  UPDATE app.fact SET digest_sent_at = NULL
  WHERE fact_id = ANY(${factIds})
`;

try {
  // Fetch them as pending digest items
  const items = await getPendingDigestItems();
  if (items.length === 0) {
    console.log("No items found after un-marking. Check the IDs.");
    await sql.end();
    process.exit(1);
  }

  console.log(`Sending test digest with ${items.length} items...`);

  const groups = groupDigestItems(items);
  const bodyText = formatDigestText(groups, items.length, []);
  const bodyHtml = formatDigestHtml(groups, items.length, []);

  // Send
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");

  await sendNotification(session, token, drafts.id, {
    subject: `Willow: [TEST] Digest — ${items.length} items`,
    bodyText,
    bodyHtml,
  });

  console.log(`Test digest sent with ${items.length} items. Check your willow folder.`);
} finally {
  // Restore digest_sent_at so these don't show up as pending
  await sql`
    UPDATE app.fact SET digest_sent_at = now()
    WHERE fact_id = ANY(${factIds})
  `;
}

await sql.end();
