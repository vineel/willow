/**
 * PIB Digest — collect digest-action facts and send a summary notification.
 */

import { sql, getSecret } from "./config";
import { getSession, getMailboxes } from "./jmap/session";
import { sendNotification } from "./jmap/notify";
import { createLogger } from "./logger";
import {
  getCalDigestSection,
  formatCalDigestText,
  formatCalDigestHtml,
} from "../cal/digest";

const log = createLogger("pib.digest");

interface DigestItem {
  factId: string;
  title: string;
  senderName: string;
  senderAddress: string;
  category: string | null;
  subcategory: string | null;
  receivedAt: string;
  fastmailUrl: string | null;
  extractedUrls: string[];
}

interface DigestGroup {
  label: string;
  items: DigestItem[];
}

interface TodoItem {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  tags: string[];
  overdue: boolean;
}

/**
 * Query pending digest items — facts with triage_action='digest' that haven't been sent yet.
 */
export async function getPendingDigestItems(): Promise<DigestItem[]> {
  const rows = await sql`
    SELECT
      f.fact_id,
      f.title,
      f.extracted_data,
      sn.metadata->>'from' as from_meta,
      sn.source_ref,
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
    // Build Fastmail web URL from JMAP message ID
    const fastmailUrl = r.source_ref
      ? `https://app.fastmail.com/mail/Inbox/${r.source_ref}`
      : null;
    // Pull any URL-like values from extracted_data
    const extractedUrls = extractUrlsFromData(r.extracted_data);
    return {
      factId: r.fact_id,
      title: r.title ?? "(no subject)",
      senderName: fromMeta.displayName ?? "Unknown",
      senderAddress: fromMeta.address ?? "unknown",
      category: r.category,
      subcategory: r.subcategory,
      receivedAt: r.received_at,
      fastmailUrl,
      extractedUrls,
    };
  });
}

/**
 * Query open todos for inclusion in the digest.
 */
async function getPendingTodos(): Promise<TodoItem[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql`
    SELECT id, title, priority, due_date, tags
    FROM app.todo
    WHERE status = 'open'
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      due_date ASC NULLS LAST
  `;

  return rows.map((r) => {
    const dueDate = r.due_date ? r.due_date.toISOString().slice(0, 10) : null;
    return {
      id: r.id,
      title: r.title,
      priority: r.priority,
      dueDate,
      tags: (r.tags ?? []) as string[],
      overdue: dueDate !== null && dueDate < today,
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
      ? `${item.category}${item.subcategory ? ` › ${item.subcategory}` : ""}`
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
export function formatDigestText(groups: DigestGroup[], count: number, todos: TodoItem[]): string {
  const lines: string[] = [];
  lines.push(`Willow Digest — ${count} item${count !== 1 ? "s" : ""}${todos.length > 0 ? `, ${todos.length} todo${todos.length !== 1 ? "s" : ""}` : ""}\n`);

  if (todos.length > 0) {
    lines.push(`\n## Pending Todos (${todos.length})\n`);
    for (const todo of todos) {
      const parts: string[] = [];
      if (todo.overdue) parts.push("OVERDUE");
      if (todo.priority !== "normal") parts.push(todo.priority.toUpperCase());
      if (todo.dueDate) parts.push(`due ${todo.dueDate}`);
      const suffix = parts.length > 0 ? ` [${parts.join(", ")}]` : "";
      lines.push(`  • ${todo.title}${suffix}`);
    }
  }

  for (const group of groups) {
    lines.push(`\n## ${group.label} (${group.items.length})\n`);
    for (const item of group.items) {
      const date = new Date(item.receivedAt).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      const linkUrl = item.extractedUrls[0] ?? item.fastmailUrl;
      lines.push(`  • ${item.title}`);
      lines.push(`    ${item.senderName} <${item.senderAddress}> — ${date}`);
      if (linkUrl) lines.push(`    ${linkUrl}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format digest as HTML.
 */
export function formatDigestHtml(groups: DigestGroup[], count: number, todos: TodoItem[]): string {
  let todoSection = "";
  if (todos.length > 0) {
    const todoRows = todos.map((todo) => {
      const badges: string[] = [];
      if (todo.overdue) badges.push('<span style="color:#dc2626;font-weight:bold">OVERDUE</span>');
      if (todo.priority !== "normal") badges.push(`<span style="color:#d97706">${escapeHtml(todo.priority)}</span>`);
      const dueStr = todo.dueDate ? `<span style="color:#666;font-size:0.9em">due ${todo.dueDate}</span>` : "";
      return `<tr>
        <td style="padding:4px 8px">${escapeHtml(todo.title)}</td>
        <td style="padding:4px 8px">${badges.join(" ")}</td>
        <td style="padding:4px 8px">${dueStr}</td>
      </tr>`;
    }).join("\n");
    todoSection = `<h3 style="margin:16px 0 8px">Pending Todos (${todos.length})</h3>
    <table style="border-collapse:collapse;width:100%">${todoRows}</table>`;
  }

  const sections = groups.map((group) => {
    const rows = group.items.map((item) => {
      const date = new Date(item.receivedAt).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      // Make the title a link — prefer extracted URL, fall back to Fastmail
      const linkUrl = item.extractedUrls[0] ?? item.fastmailUrl;
      const titleHtml = linkUrl
        ? `<a href="${escapeHtml(linkUrl)}" style="color:#1a73e8;text-decoration:none">${escapeHtml(item.title)}</a>`
        : escapeHtml(item.title);
      // If there's both an extracted URL and a Fastmail link, show a small "view email" link
      const emailLink = item.extractedUrls.length > 0 && item.fastmailUrl
        ? ` <a href="${escapeHtml(item.fastmailUrl)}" style="color:#999;font-size:0.8em;text-decoration:none">[email]</a>`
        : "";
      return `<tr>
        <td style="padding:4px 8px">${titleHtml}${emailLink}</td>
        <td style="padding:4px 8px;color:#666">${escapeHtml(item.senderName)}</td>
        <td style="padding:4px 8px;color:#999;font-size:0.9em">${date}</td>
      </tr>`;
    }).join("\n");

    return `<h3 style="margin:16px 0 8px">${escapeHtml(group.label)} (${group.items.length})</h3>
    <table style="border-collapse:collapse;width:100%">${rows}</table>`;
  }).join("\n");

  const subtitle = todos.length > 0 ? `, ${todos.length} todo${todos.length !== 1 ? "s" : ""}` : "";
  return `<div style="font-family:system-ui,sans-serif;max-width:600px">
    <h2>Willow Digest — ${count} item${count !== 1 ? "s" : ""}${subtitle}</h2>
    ${todoSection}
    ${sections}
  </div>`;
}

/**
 * Pull URL-like values out of an extracted_data jsonb object.
 */
function extractUrlsFromData(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const urls: string[] = [];
  for (const [, val] of Object.entries(data as Record<string, unknown>)) {
    if (typeof val === "string" && /^https?:\/\/.+/.test(val)) {
      urls.push(val);
    }
  }
  return urls;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Preview what the digest would contain without sending.
 */
export async function previewDigest(): Promise<{ text: string; count: number }> {
  const items = await getPendingDigestItems();
  const todos = await getPendingTodos();
  const calSection = await getCalDigestSection();

  if (items.length === 0 && todos.length === 0 && !calSection) {
    return { text: "No pending digest items, todos, or calendar events.", count: 0 };
  }
  const groups = groupDigestItems(items);
  let text = formatDigestText(groups, items.length, todos);
  if (calSection) {
    text += "\n" + formatCalDigestText(calSection);
  }
  return { text, count: items.length };
}

/**
 * Send the digest and mark all included items as sent.
 */
export async function sendDigest(): Promise<{ sent: boolean; count: number }> {
  const items = await getPendingDigestItems();
  const todos = await getPendingTodos();
  const calSection = await getCalDigestSection();

  if (items.length === 0 && todos.length === 0 && !calSection) {
    log.info("No pending digest items, todos, or calendar events");
    return { sent: false, count: 0 };
  }
  log.info(`Composing digest with ${items.length} items, ${todos.length} todos${calSection ? ", calendar section" : ""}`);

  const groups = groupDigestItems(items);
  let bodyText = formatDigestText(groups, items.length, todos);
  let bodyHtml = formatDigestHtml(groups, items.length, todos);

  if (calSection) {
    bodyText += "\n" + formatCalDigestText(calSection);
    bodyHtml = bodyHtml.replace(
      "</div>",
      formatCalDigestHtml(calSection) + "</div>"
    );
  }

  // Send via JMAP
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });

  const todoPart = todos.length > 0 ? `, ${todos.length} todo${todos.length !== 1 ? "s" : ""}` : "";
  await sendNotification(session, token, drafts.id, {
    subject: `Willow: Daily digest — ${items.length} items${todoPart} (${today})`,
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
