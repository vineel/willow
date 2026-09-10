// Shared formatter for the chat-displayable preview blocks. Used by both
// the foldersort:preview CLI and the preview_inbox_sort MCP tool so the
// output stays identical between terminal and chat.

import type { CanonicalEvent } from "../jmap/types";
import type { FolderDecision } from "./types";

export interface PreviewItem {
  factId: string;
  event: CanonicalEvent;
  decision: FolderDecision;
  receivedAt: string | Date;
}

function shortId(factId: string): string {
  return factId.slice(0, 4);
}

function fmtAddr(name: string | null | undefined, email: string): string {
  return name ? `${name} <${email}>` : email;
}

function fmtDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function formatPreviewItem(item: PreviewItem, index: number): string {
  const e = item.event;
  const subject = truncate(e.subject ?? "(no subject)", 90);
  const from = fmtAddr(e.fromEntity.displayName, e.fromEntity.address);
  const reason = item.decision.reason
    ? `  (${item.decision.decided_by}: ${item.decision.reason})`
    : `  (${item.decision.decided_by})`;
  return [
    `#${index + 1}  [fact:${shortId(item.factId)}]   ${fmtDate(item.receivedAt)}`,
    `    From:     ${from}`,
    `    Subject:  ${subject}`,
    `    →         ${item.decision.target}${reason}`,
  ].join("\n");
}

export function formatPreviewList(items: PreviewItem[]): string {
  if (items.length === 0) return "(no emails to preview)";
  return items.map((it, i) => formatPreviewItem(it, i)).join("\n\n");
}
