/**
 * PIB Digest — collect digest-action facts and send a summary notification.
 */

import { sql, getSecret } from "./config";
import { getSession, getMailboxes } from "./jmap/session";
import { sendNotification } from "./jmap/notify";
import { createLogger } from "./logger";

const log = createLogger("pib.digest");

interface DigestItem {
  factId: string;
  title: string;
  senderName: string;
  senderAddress: string;
  category: string | null;
  subcategory: string | null;
  receivedAt: string;
}

interface DigestGroup {
  label: string;
  items: DigestItem[];
}

/**
 * Query pending digest items — facts with triage_action='digest' that haven't been sent yet.
 */
export async function getPendingDigestItems(): Promise<DigestItem[]> {
  const rows = await sql`
    SELECT
      f.fact_id,
      f.title,
      sn.metadata->>'from' as from_meta,
      sn.received_at,
      i.category,
      i.subcategory
    FROM app.fact f
    JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
    LEFT JOIN app.intent i ON f.intent_id = i.id
    WHERE f.triage_action = 'digest'
      AND f.digest_sent_at IS NULL
      AND sn.source_type = 'email'
    ORDER BY sn.received_at DESC
  `;

  return rows.map((r) => {
    const fromMeta = r.from_meta ? JSON.parse(r.from_meta) : {};
    return {
      factId: r.fact_id,
      title: r.title ?? "(no subject)",
      senderName: fromMeta.displayName ?? "Unknown",
      senderAddress: fromMeta.address ?? "unknown",
      category: r.category,
      subcategory: r.subcategory,
      receivedAt: r.received_at,
    };
  });
}

/**
 * Group digest items by category for display.
 */
export function groupDigestItems(items: DigestItem[]): DigestGroup[] {
  const groups = new Map<string, DigestItem[]>();

  for (const item of items) {
    const label = item.category
      ? `${item.category}${item.subcategory ? `.${item.subcategory}` : ""}`
      : "uncategorized";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, items]) => ({ label, items }));
}

/**
 * Format digest as plain text.
 */
function formatDigestText(groups: DigestGroup[], count: number): string {
  const lines: string[] = [];
  lines.push(`Willow Digest — ${count} item${count !== 1 ? "s" : ""}\n`);

  for (const group of groups) {
    lines.push(`\n## ${group.label} (${group.items.length})\n`);
    for (const item of group.items) {
      const date = new Date(item.receivedAt).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      lines.push(`  • ${item.title}`);
      lines.push(`    ${item.senderName} <${item.senderAddress}> — ${date}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format digest as HTML.
 */
function formatDigestHtml(groups: DigestGroup[], count: number): string {
  const sections = groups.map((group) => {
    const rows = group.items.map((item) => {
      const date = new Date(item.receivedAt).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      return `<tr>
        <td style="padding:4px 8px">${escapeHtml(item.title)}</td>
        <td style="padding:4px 8px;color:#666">${escapeHtml(item.senderName)}</td>
        <td style="padding:4px 8px;color:#999;font-size:0.9em">${date}</td>
      </tr>`;
    }).join("\n");

    return `<h3 style="margin:16px 0 8px">${escapeHtml(group.label)} (${group.items.length})</h3>
    <table style="border-collapse:collapse;width:100%">${rows}</table>`;
  }).join("\n");

  return `<div style="font-family:system-ui,sans-serif;max-width:600px">
    <h2>Willow Digest — ${count} item${count !== 1 ? "s" : ""}</h2>
    ${sections}
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Preview what the digest would contain without sending.
 */
export async function previewDigest(): Promise<{ text: string; count: number }> {
  const items = await getPendingDigestItems();
  if (items.length === 0) {
    return { text: "No pending digest items.", count: 0 };
  }
  const groups = groupDigestItems(items);
  return { text: formatDigestText(groups, items.length), count: items.length };
}

/**
 * Send the digest and mark all included items as sent.
 */
export async function sendDigest(): Promise<{ sent: boolean; count: number }> {
  const items = await getPendingDigestItems();
  if (items.length === 0) {
    log.info("No pending digest items");
    return { sent: false, count: 0 };
  }
  log.info(`Composing digest with ${items.length} items across ${groupDigestItems(items).length} categories`);

  const groups = groupDigestItems(items);
  const bodyText = formatDigestText(groups, items.length);
  const bodyHtml = formatDigestHtml(groups, items.length);

  // Send via JMAP
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });

  await sendNotification(session, token, drafts.id, {
    subject: `Willow: Daily digest — ${items.length} items (${today})`,
    bodyText,
    bodyHtml,
  });

  // Mark all items as sent
  const factIds = items.map((i) => i.factId);
  await sql`
    UPDATE app.fact SET digest_sent_at = now()
    WHERE fact_id = ANY(${factIds})
  `;

  log.info(`Digest sent: ${items.length} items, ${groupDigestItems(items).length} categories`);
  return { sent: true, count: items.length };
}
