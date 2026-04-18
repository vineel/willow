/**
 * Format and send portfolio valuation report.
 */

import { getSecret } from "../config";
import { getSession, getMailboxes } from "../jmap/session";
import { sendNotification } from "../jmap/notify";
import { createLogger } from "../logger";
import type { ValuationResult, TickerMove } from "./valuate";

const log = createLogger("pib.portfolio.report");

export type ReportVariant = "premarket" | "midday" | "postclose";

const VARIANT_LABEL: Record<ReportVariant, string> = {
  premarket: "Pre-Market",
  midday: "Mid-Day",
  postclose: "Post-Close",
};

function formatCurrency(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPrice(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMoveText(m: TickerMove): string {
  const arrow = m.priceChange >= 0 ? "▲" : "▼";
  const absDollar = Math.abs(m.priceChange).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const absPct = Math.abs(m.pctChange).toFixed(2);
  return `${m.ticker}: ${formatPrice(m.price)}  ${arrow}$${absDollar}  ${arrow}${absPct}%`;
}

function formatMoveHtml(m: TickerMove): string {
  const up = m.priceChange >= 0;
  const arrow = up ? "▲" : "▼";
  const color = up ? "#0a7a3a" : "#b00020";
  const absDollar = Math.abs(m.priceChange).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const absPct = Math.abs(m.pctChange).toFixed(2);
  return `<div style="font-family:ui-monospace,monospace;margin:2px 0">
  <span style="display:inline-block;min-width:70px;font-weight:600">${m.ticker}</span>
  <span style="display:inline-block;min-width:90px">${formatPrice(m.price)}</span>
  <span style="color:${color};display:inline-block;min-width:90px">${arrow} $${absDollar}</span>
  <span style="color:${color}">${arrow} ${absPct}%</span>
</div>`;
}

function getEasternTime(): { dateLong: string; dateShort: string; time: string } {
  const now = new Date();
  const opts = { timeZone: "America/New_York" } as const;

  const dateLong = now.toLocaleDateString("en-US", {
    ...opts,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const dateShort = now.toLocaleDateString("en-US", {
    ...opts,
    month: "short",
    day: "numeric",
  });

  const time = now.toLocaleTimeString("en-US", {
    ...opts,
    hour: "numeric",
    minute: "2-digit",
  });

  return { dateLong, dateShort, time };
}

/**
 * Send portfolio valuation as a Willow notification.
 */
export async function sendPortfolioReport(
  result: ValuationResult,
  variant: ReportVariant = "midday"
): Promise<void> {
  const { dateLong, dateShort, time } = getEasternTime();
  const total = formatCurrency(result.totalValue);
  const label = VARIANT_LABEL[variant];
  const showMovers = variant !== "premarket";

  const subject = `Willow: Portfolio ${label} — ${dateShort}, ${time} ET`;

  const textLines = [
    `Date: ${dateLong}`,
    `Time: ${time} ET (${label})`,
    "",
    `Total Portfolio Value: ${total}`,
  ];

  if (showMovers && result.northStars.length > 0) {
    textLines.push("", "North Stars", "-----------");
    for (const m of result.northStars) textLines.push(formatMoveText(m));
  }

  if (showMovers) {
    textLines.push("", "Big Movers", "----------");
    if (result.bigMovers.length === 0) {
      textLines.push("(no holdings moved more than ±2% today)");
    } else {
      for (const m of result.bigMovers) textLines.push(formatMoveText(m));
    }
  }

  if (result.missing.length > 0) {
    textLines.push("", `Note: Could not price ${result.missing.length} holding(s): ${result.missing.join(", ")}`);
  }

  const bodyText = textLines.join("\n");

  const northStarsHtml = showMovers && result.northStars.length > 0
    ? `<h2 style="margin:24px 0 8px;font-size:16px">North Stars</h2>${result.northStars.map(formatMoveHtml).join("")}`
    : "";

  const bigMoversHtml = showMovers
    ? `<h2 style="margin:24px 0 8px;font-size:16px">Big Movers</h2>${
        result.bigMovers.length === 0
          ? `<div style="color:#999;font-style:italic">No holdings moved more than ±2% today.</div>`
          : result.bigMovers.map(formatMoveHtml).join("")
      }`
    : "";

  const bodyHtml = `<div style="font-family:system-ui,sans-serif;max-width:560px">
  <p style="color:#666;margin:0">Date: ${dateLong}</p>
  <p style="color:#666;margin:0">Time: ${time} ET (${label})</p>
  <h1 style="margin:16px 0;font-size:32px">${total}</h1>
  ${northStarsHtml}
  ${bigMoversHtml}
  ${result.missing.length > 0 ? `<p style="color:#999;font-size:0.9em;margin-top:24px">Could not price: ${result.missing.join(", ")}</p>` : ""}
</div>`;

  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");

  await sendNotification(session, token, drafts.id, {
    subject,
    bodyText,
    bodyHtml,
  });

  log.info(`Portfolio report sent: ${total} (${label}, ${result.bigMovers.length} movers)`);
}
