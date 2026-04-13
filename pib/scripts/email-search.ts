/**
 * Search emails via Fastmail JMAP full-text search.
 *
 * Usage:
 *   bun run pib:search -- "3d printer"
 *   bun run pib:search -- "3d printer" --limit 20
 */
import { getSecret } from "../config";
import { getSession } from "../jmap/session";
import { jmapRequest } from "../jmap/client";

const args = process.argv.slice(2).filter((a) => a !== "--");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "10", 10) : 10;
const query = args.filter((a) => !a.startsWith("--") && (limitIdx === -1 || args.indexOf(a) !== limitIdx + 1)).join(" ");

if (!query) {
  console.log("Usage: bun run pib:search -- \"search terms\" [--limit N]");
  process.exit(1);
}

const token = await getSecret("fastmail-token");
const session = await getSession(token);

// Search all mailboxes using JMAP text filter
const queryResponse = await jmapRequest(session.apiUrl, token, [
  [
    "Email/query",
    {
      accountId: session.accountId,
      filter: { text: query },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit,
    },
    "q1",
  ],
]);

const [, qResult] = queryResponse.methodResponses[0];
const ids = qResult.ids as string[];

if (ids.length === 0) {
  console.log(`No emails found for "${query}"`);
  process.exit(0);
}

// Fetch the matching emails
const getResponse = await jmapRequest(session.apiUrl, token, [
  [
    "Email/get",
    {
      accountId: session.accountId,
      ids,
      properties: ["id", "subject", "from", "receivedAt"],
    },
    "g1",
  ],
]);

const [, gResult] = getResponse.methodResponses[0];
const emails = gResult.list as { id: string; subject: string; from: { name?: string; email: string }[]; receivedAt: string }[];

console.log(`Found ${emails.length} emails for "${query}":\n`);
for (const email of emails) {
  const sender = email.from?.[0];
  const senderStr = sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : "unknown";
  const date = new Date(email.receivedAt).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  console.log(`  ${email.subject}`);
  console.log(`    ${senderStr} — ${date}`);
  console.log(`    https://app.fastmail.com/mail/Inbox/${email.id}`);
  console.log();
}
