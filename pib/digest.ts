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

const PUBLIC_URL = process.env.WILLOW_PUBLIC_URL ?? "http://terokNor.local:8787";

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

interface SopacEvent {
  title: string;
  dateText: string;
  url: string;
}

interface SopacDigestSection {
  events: SopacEvent[];
  sourceUrl: string;
}

interface MovieDigestSection {
  title: string;
  movies: string[];
}

const SOPAC_EVENTS_URL = "https://www.sopacnow.org/events/";
const SOPAC_LOOKAHEAD_DAYS = 30;

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
    ORDER BY sort_order DESC,
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

function formatSopacDigestText(section: SopacDigestSection): string {
  const lines: string[] = [];
  lines.push(`\n## SOPAC: Next ${SOPAC_LOOKAHEAD_DAYS} Days (${section.events.length})\n`);
  for (const event of section.events) {
    lines.push(`  • ${event.dateText} — ${event.title}`);
    lines.push(`    ${event.url}`);
  }
  lines.push(`\n  Source: ${section.sourceUrl}`);
  return lines.join("\n");
}

function formatMovieDigestText(section: MovieDigestSection): string {
  const lines: string[] = [];
  lines.push(`\n## ${section.title} (${section.movies.length})\n`);
  for (const movie of section.movies) {
    lines.push(`  • ${movie}`);
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

function formatSopacDigestHtml(section: SopacDigestSection): string {
  const rows = section.events.map((event) => `<tr>
    <td style="padding:4px 8px;color:#666;white-space:nowrap">${escapeHtml(event.dateText)}</td>
    <td style="padding:4px 8px"><a href="${escapeHtml(event.url)}" style="color:#1a73e8;text-decoration:none">${escapeHtml(event.title)}</a></td>
  </tr>`).join("\n");

  return `<h3 style="margin:16px 0 8px">SOPAC: Next ${SOPAC_LOOKAHEAD_DAYS} Days (${section.events.length})</h3>
  <table style="border-collapse:collapse;width:100%">${rows}</table>
  <p style="margin:8px 0 0;color:#999;font-size:0.85em">
    Source: <a href="${section.sourceUrl}" style="color:#999">${section.sourceUrl}</a>
  </p>`;
}

function formatMovieDigestHtml(section: MovieDigestSection): string {
  const rows = section.movies.map((movie) => `<tr>
    <td style="padding:4px 8px">${escapeHtml(movie)}</td>
  </tr>`).join("\n");

  return `<h3 style="margin:16px 0 8px">${escapeHtml(section.title)} (${section.movies.length})</h3>
  <table style="border-collapse:collapse;width:100%">${rows}</table>`;
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

function decodeHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function easternDateParts(date: Date): { year: number; month: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday"),
  };
}

function easternDayNumber(date: Date): number {
  const parts = easternDateParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

function parseSopacEventDay(dateText: string, fallbackYear: number): number | null {
  const months: Record<string, number> = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };
  const firstYear = dateText.match(/\b(20\d{2})\b/)?.[1];
  const match = dateText.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s+(\d{1,2})(?:,\s*(20\d{2}))?/i);
  if (!match) return null;
  const month = months[match[1].toLowerCase().replace(".", "")];
  const day = Number(match[2]);
  const year = Number(match[3] ?? firstYear ?? fallbackYear);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return Date.UTC(year, month, day) / 86_400_000;
}

function parseSopacEvents(html: string, now: Date): SopacEvent[] {
  const today = easternDayNumber(now);
  const end = today + SOPAC_LOOKAHEAD_DAYS;
  const fallbackYear = easternDateParts(now).year;
  const events: SopacEvent[] = [];
  const seen = new Set<string>();
  const eventPattern = /<article\b[\s\S]*?<h2 class="entry-title">\s*<a[^>]*href="([^"]+)"[\s\S]*?<span class="title">([\s\S]*?)<\/span>[\s\S]*?<h4 class="dates">\s*([\s\S]*?)\s*<\/h4>/g;

  for (const match of html.matchAll(eventPattern)) {
    const url = decodeHtml(match[1]);
    const title = decodeHtml(match[2]);
    const dateText = decodeHtml(match[3]);
    const day = parseSopacEventDay(dateText, fallbackYear);
    if (day === null || day < today || day > end) continue;
    const key = `${dateText}|${title}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ title, dateText, url });
  }

  return events;
}

function parseMovieList(description: string | null): string[] {
  if (!description) return [];
  return description
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
}

export async function getSopacDigestSection(now = new Date()): Promise<SopacDigestSection | null> {
  if (easternDateParts(now).weekday !== "Fri") return null;

  const response = await fetch(SOPAC_EVENTS_URL, {
    headers: { "user-agent": "Willow digest (+https://www.sopacnow.org/events/)" },
  });
  if (!response.ok) {
    log.error(`SOPAC fetch failed: ${response.status} ${response.statusText}`);
    return null;
  }

  const html = await response.text();
  const events = parseSopacEvents(html, now);
  if (events.length === 0) return null;
  return { events, sourceUrl: SOPAC_EVENTS_URL };
}

export async function getMovieDigestSection(now = new Date()): Promise<MovieDigestSection | null> {
  if (easternDateParts(now).weekday !== "Fri") return null;

  const [row] = await sql`
    SELECT title, description
    FROM app.todo
    WHERE status = 'open'
      AND tags @> ${["movies", "watchlist"] as string[]}
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (!row) return null;

  const movies = parseMovieList(row.description);
  if (movies.length === 0) return null;
  return { title: row.title ?? "Movies to watch", movies };
}

/**
 * Preview what the digest would contain without sending.
 */
export async function previewDigest(): Promise<{ text: string; count: number }> {
  const items = await getPendingDigestItems();
  const todos = await getPendingTodos();
  const calSection = await getCalDigestSection();
  const sopacSection = await getSopacDigestSection();
  const movieSection = await getMovieDigestSection();

  if (items.length === 0 && todos.length === 0 && !calSection && !sopacSection && !movieSection) {
    return { text: "No pending digest items, todos, or calendar events.", count: 0 };
  }
  const groups = groupDigestItems(items);
  let text = formatDigestText(groups, items.length, todos);
  if (calSection) {
    text += "\n" + formatCalDigestText(calSection);
  }
  if (sopacSection) {
    text += "\n" + formatSopacDigestText(sopacSection);
  }
  if (movieSection) {
    text += "\n" + formatMovieDigestText(movieSection);
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
  const sopacSection = await getSopacDigestSection();
  const movieSection = await getMovieDigestSection();

  if (items.length === 0 && todos.length === 0 && !calSection && !sopacSection && !movieSection) {
    log.info("No pending digest items, todos, or calendar events");
    return { sent: false, count: 0 };
  }
  log.info(`Composing digest with ${items.length} items, ${todos.length} todos${calSection ? ", calendar section" : ""}${sopacSection ? ", SOPAC section" : ""}${movieSection ? ", movie section" : ""}`);

  const groups = groupDigestItems(items);
  let bodyText = formatDigestText(groups, items.length, todos);
  let bodyHtml = formatDigestHtml(groups, items.length, todos);

  const footerHtml = `<hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px">
  <p style="color:#999;font-size:0.85em;margin:0">
    <a href="${PUBLIC_URL}/todos" style="color:#999">Manage todos</a>
  </p>`;
  const calHtml = calSection ? formatCalDigestHtml(calSection) : "";
  const sopacHtml = sopacSection ? formatSopacDigestHtml(sopacSection) : "";
  const movieHtml = movieSection ? formatMovieDigestHtml(movieSection) : "";
  bodyHtml = bodyHtml.replace("</div>", calHtml + sopacHtml + movieHtml + footerHtml + "</div>");

  bodyText += (calSection ? "\n" + formatCalDigestText(calSection) : "")
           + (sopacSection ? "\n" + formatSopacDigestText(sopacSection) : "")
           + (movieSection ? "\n" + formatMovieDigestText(movieSection) : "")
           + `\n\n---\nManage todos: ${PUBLIC_URL}/todos\n`;

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
