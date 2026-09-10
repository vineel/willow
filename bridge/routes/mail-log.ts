// Mail sort log: a persistent, ever-growing page listing every email Willow
// has ingested — where it landed (folder or left in inbox), who sent it, and
// a short description — newest first. Lets Vineel spot-check that nothing
// important is getting silently misfiled, and lets Willow itself answer
// questions about sort history via /mail-log.json.

import type { FastifyInstance } from "fastify";
import { sql } from "../db.js";
import { getSecret } from "../../pib/config";
import { getSession, getMailboxes } from "../../pib/jmap/session";

const DEFAULT_LIMIT = 300;
const SEARCH_DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;
const MAX_SEARCH_WORDS = 10;

interface MailLogRow {
  fact_id: string;
  title: string | null;
  category: string | null;
  subcategory: string | null;
  triage_action: string | null;
  folder_target: string | null;
  folder_decided_by: string | null;
  folder_reason: string | null;
  folder_error: string | null;
  source_ref: string | null;
  received_at: Date | null;
  raw_text: string;
  metadata: { from?: { displayName?: string; name?: string; address?: string; email?: string }; mailboxIds?: Record<string, boolean> } | null;
}

// Foldersort only decides a target for emails synced from the Inbox folder
// (see pib/pipeline.ts). Emails ingested from the other synced folders
// (for-willow, not-for-willow, Ai Buzz) never get folder_target set, so we
// fall back to resolving their actual mailbox from JMAP — otherwise they'd
// be mislabeled "Inbox" even though they're sitting elsewhere.
let cachedMailboxIndex: Map<string, string> | null = null;
async function getMailboxIndex(): Promise<Map<string, string>> {
  if (cachedMailboxIndex) return cachedMailboxIndex;
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  cachedMailboxIndex = new Map(mailboxes.map((m) => [m.id, m.name] as const));
  return cachedMailboxIndex;
}

export interface MailLogEntry {
  factId: string;
  title: string;
  senderName: string;
  senderAddress: string;
  receivedAt: string | null;
  folder: string;
  decidedBy: string | null;
  reason: string | null;
  blocked: boolean;
  classification: string | null;
  description: string | null;
  fastmailUrl: string | null;
}

// Some senders put raw HTML in the "text" body part, so strip tags/entities
// defensively rather than trusting it's already plain text.
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// raw_text is "Subject: ...\nFrom: ...\nTo: ...\nDate: ...\n\n<body>" — pull
// just the body, then trim it down to a short preview.
function previewFromRawText(rawText: string): string | null {
  const blankLineIdx = rawText.indexOf("\n\n");
  const body = blankLineIdx >= 0 ? rawText.slice(blankLineIdx + 2) : rawText;
  const cleaned = stripHtml(body).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "…" : cleaned;
}

function resolveFolder(
  folderTarget: string | null,
  mailboxIds: Record<string, boolean> | undefined,
  mailboxIndex: Map<string, string>
): string {
  if (folderTarget) return folderTarget === "leave_in_inbox" ? "Inbox" : folderTarget;
  const names = Object.keys(mailboxIds ?? {})
    .map((id) => mailboxIndex.get(id))
    .filter((n): n is string => !!n);
  return names.length > 0 ? names.join(", ") : "Inbox";
}

// "any word match": OR the words together into one case-insensitive regex
// alternation, checked against every searchable field.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSearchWords(q: string | undefined): string[] {
  if (!q) return [];
  return Array.from(new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))).slice(0, MAX_SEARCH_WORDS);
}

async function listMailLog(limit: number, words: string[] = []): Promise<MailLogEntry[]> {
  const pattern = words.length > 0 ? words.map(escapeRegex).join("|") : null;
  const rows = (await sql`
    SELECT
      f.fact_id, f.title, f.triage_action,
      f.folder_target, f.folder_decided_by, f.folder_reason, f.folder_error,
      i.category, i.subcategory,
      sn.source_ref, sn.received_at, sn.raw_text, sn.metadata
    FROM app.fact f
    JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
    LEFT JOIN app.intent i ON f.intent_id = i.id
    WHERE sn.source_type = 'email'
      ${pattern ? sql`
      AND (
        f.title ~* ${pattern}
        OR sn.raw_text ~* ${pattern}
        OR f.folder_target ~* ${pattern}
        OR i.category ~* ${pattern}
        OR i.subcategory ~* ${pattern}
        OR sn.metadata->>'from' ~* ${pattern}
      )` : sql``}
    ORDER BY sn.received_at DESC NULLS LAST
    LIMIT ${limit}
  `) as unknown as MailLogRow[];

  let mailboxIndex: Map<string, string>;
  try {
    mailboxIndex = await getMailboxIndex();
  } catch {
    mailboxIndex = new Map();
  }

  return rows.map((r) => {
    const from = r.metadata?.from ?? {};
    return {
      factId: r.fact_id,
      title: r.title ?? "(no subject)",
      senderName: from.displayName ?? from.name ?? "Unknown",
      senderAddress: from.address ?? from.email ?? "unknown",
      receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
      folder: resolveFolder(r.folder_target, r.metadata?.mailboxIds, mailboxIndex),
      decidedBy: r.folder_decided_by,
      reason: r.folder_reason ?? r.folder_error,
      blocked: r.triage_action === "noise",
      classification: r.category ? `${r.category}.${r.subcategory}` : null,
      description: previewFromRawText(r.raw_text),
      fastmailUrl: r.source_ref ? `https://app.fastmail.com/mail/Inbox/${r.source_ref}` : null,
    };
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Wraps matches in <mark>. Runs on already-escaped HTML text, so the words
// are escaped the same way before being turned into a regex.
function highlight(escapedText: string, words: string[]): string {
  if (words.length === 0) return escapedText;
  const pattern = words.map((w) => escapeRegex(escapeHtml(w))).join("|");
  try {
    const re = new RegExp(`(${pattern})`, "gi");
    return escapedText.replace(re, `<mark style="background:#fff3a3;color:#000;padding:0 1px">$1</mark>`);
  } catch {
    return escapedText;
  }
}

function renderPage(entries: MailLogEntry[], limit: number, q: string, words: string[]): string {
  const rows = entries.map((e) => {
    const date = e.receivedAt
      ? new Date(e.receivedAt).toLocaleString("en-US", {
          month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
        })
      : "unknown date";
    const titleText = highlight(escapeHtml(e.title), words);
    const titleHtml = e.fastmailUrl
      ? `<a href="${escapeHtml(e.fastmailUrl)}" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none;font-weight:600;overflow-wrap:anywhere">${titleText}</a>`
      : `<span style="font-weight:600;overflow-wrap:anywhere">${titleText}</span>`;
    const senderHtml = `${highlight(escapeHtml(e.senderName), words)} <span style="color:#999">&lt;${highlight(escapeHtml(e.senderAddress), words)}&gt;</span>`;
    const descHtml = e.description
      ? `<div style="color:#555;font-size:0.88em;margin-top:4px;overflow-wrap:anywhere">${highlight(escapeHtml(e.description), words)}</div>`
      : "";
    const blockedBadge = e.blocked
      ? `<span title="triaged as noise" style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;background:#fde8e8;color:#c0392b;font-size:0.75em;font-weight:600">blocked</span>`
      : "";
    const classificationBadge = e.classification
      ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;background:#f0f0f0;color:#777;font-size:0.75em">${escapeHtml(e.classification)}</span>`
      : "";
    const folderTitle = [e.decidedBy ? `decided by: ${e.decidedBy}` : null, e.reason ?? null]
      .filter(Boolean)
      .join(" — ");
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;color:#999;font-size:0.85em;vertical-align:top">${date}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top;overflow:hidden">
        ${titleHtml}${blockedBadge}${classificationBadge}
        <div style="color:#666;font-size:0.85em;margin-top:2px;overflow-wrap:anywhere">${senderHtml}</div>
        ${descHtml}
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top" title="${escapeHtml(folderTitle)}">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#eef2ff;color:#3b4ba0;font-size:0.85em;font-weight:600">${escapeHtml(e.folder)}</span>
      </td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Willow Mail Sort Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222">
  <h2 style="margin-bottom:4px">Willow Mail Sort Log</h2>
  <form method="GET" action="/mail-log" style="display:flex;gap:8px;margin:12px 0">
    <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search sender, subject, body… (any word matches)"
      style="flex:1;min-width:0;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:0.95em;font-family:inherit">
    <button type="submit" style="padding:8px 16px;border:none;border-radius:6px;background:#1a73e8;color:#fff;font-size:0.9em;font-weight:600;cursor:pointer">Search</button>
    ${q ? `<a href="/mail-log" style="align-self:center;color:#999;font-size:0.85em;text-decoration:none;white-space:nowrap">Clear</a>` : ""}
  </form>
  <p style="color:#999;font-size:0.9em;margin-top:0">
    ${q
      ? `${entries.length} result${entries.length !== 1 ? "s" : ""} for “${escapeHtml(q)}”${entries.length === limit ? ` (showing up to ${limit})` : ""}`
      : `Every email Willow has processed, newest first — showing ${entries.length}${entries.length === limit ? ` of the most recent (limit=${limit})` : ""}.`}
    <a href="/mail-log.json${q ? `?q=${encodeURIComponent(q)}` : ""}" style="color:#999">JSON</a>
  </p>
  <table style="border-collapse:collapse;width:100%;table-layout:fixed">
    <colgroup>
      <col style="width:15%">
      <col>
      <col style="width:110px">
    </colgroup>
    <thead>
      <tr style="text-align:left">
        <th style="padding:6px 8px;border-bottom:2px solid #ddd;font-size:0.8em;color:#999;text-transform:uppercase">Received</th>
        <th style="padding:6px 8px;border-bottom:2px solid #ddd;font-size:0.8em;color:#999;text-transform:uppercase">Email</th>
        <th style="padding:6px 8px;border-bottom:2px solid #ddd;font-size:0.8em;color:#999;text-transform:uppercase">Folder</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="3" style="padding:24px 8px;color:#999;text-align:center">${q ? `No emails match “${escapeHtml(q)}”.` : "No emails yet."}</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;
}

function parseLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function parseQuery(raw: Record<string, unknown>): string {
  return typeof raw.q === "string" ? raw.q.trim() : "";
}

export async function mailLogRoutes(fastify: FastifyInstance) {
  fastify.get("/mail-log", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const q = parseQuery(query);
    const words = parseSearchWords(q);
    const limit = parseLimit(query.limit, words.length > 0 ? SEARCH_DEFAULT_LIMIT : DEFAULT_LIMIT);
    const entries = await listMailLog(limit, words);
    reply.type("text/html; charset=utf-8");
    return renderPage(entries, limit, q, words);
  });

  fastify.get("/mail-log.json", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const q = parseQuery(query);
    const words = parseSearchWords(q);
    const limit = parseLimit(query.limit, words.length > 0 ? SEARCH_DEFAULT_LIMIT : DEFAULT_LIMIT);
    const entries = await listMailLog(limit, words);
    return { count: entries.length, limit, q: q || null, entries };
  });
}
