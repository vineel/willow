import YahooFinance from "yahoo-finance2";
import { parsePositions } from "../pib/portfolio/positions";
import { getSecret } from "../pib/config";
import { getSession, getMailboxes } from "../pib/jmap/session";
import { sendEmail } from "../pib/jmap/notify";

const POSITIONS_FILE =
  "/Users/vineel/willow-runtime-workspace/information-sources/all-positions-combined.md";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

type Row = {
  ticker: string;
  shares: number;
  latestDate: string;
  ytdPct: number | null;
  oneYearPct: number | null;
  oneYearTotalChange: number | null;
  totalClose: number;
};

function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function latestCloseOnOrBefore(
  prices: Array<{ date: Date; close?: number | null }>,
  target: Date
): { date: Date; close: number } | null {
  const targetMs = target.getTime();
  for (let i = prices.length - 1; i >= 0; i--) {
    const p = prices[i];
    if (p.date.getTime() <= targetMs && p.close != null && Number.isFinite(p.close)) {
      return { date: p.date, close: p.close };
    }
  }
  return null;
}

async function historyFor(ticker: string, start: Date, end: Date) {
  return await yahooFinance.historical(ticker, {
    period1: start,
    period2: end,
    interval: "1d",
  });
}

function markdownTable(rows: Row[]): string {
  const lines = [
    "TICKER|% change YTD (for 1 share)|% change 1y (for 1 share)|TOTAL $ change 1 yr|TOTAL $ close today",
    "---|---:|---:|---:|---:",
  ];
  for (const r of rows) {
    lines.push([
      r.ticker,
      pct(r.ytdPct),
      pct(r.oneYearPct),
      money(r.oneYearTotalChange),
      money(r.totalClose),
    ].join("|"));
  }
  return lines.join("\n");
}

function htmlTable(rows: Row[]): string {
  const cells = (value: string, align = "right") =>
    `<td style="padding:4px 8px;text-align:${align};border-bottom:1px solid #ddd">${value}</td>`;
  return `<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">
<thead><tr>
<th style="text-align:left;padding:4px 8px;border-bottom:2px solid #bbb">TICKER</th>
<th style="text-align:right;padding:4px 8px;border-bottom:2px solid #bbb">% change YTD<br>(for 1 share)</th>
<th style="text-align:right;padding:4px 8px;border-bottom:2px solid #bbb">% change 1y<br>(for 1 share)</th>
<th style="text-align:right;padding:4px 8px;border-bottom:2px solid #bbb">TOTAL $ change 1 yr</th>
<th style="text-align:right;padding:4px 8px;border-bottom:2px solid #bbb">TOTAL $ close today</th>
</tr></thead>
<tbody>
${rows.map((r) => `<tr>${cells(r.ticker, "left")}${cells(pct(r.ytdPct))}${cells(pct(r.oneYearPct))}${cells(money(r.oneYearTotalChange))}${cells(money(r.totalClose))}</tr>`).join("\n")}
</tbody></table>`;
}

async function main() {
  const today = new Date("2026-06-15T23:59:59Z");
  const ytdTarget = new Date("2025-12-31T23:59:59Z");
  const oneYearTarget = new Date("2025-06-15T23:59:59Z");
  const historyStart = new Date("2025-05-15T00:00:00Z");
  const historyEnd = addDays(today, 2);

  const holdings = parsePositions(POSITIONS_FILE)
    .filter((h) => !h.isCash)
    .reduce((map, h) => {
      map.set(h.ticker, (map.get(h.ticker) ?? 0) + h.shares);
      return map;
    }, new Map<string, number>());

  const rows: Row[] = [];
  const failures: string[] = [];

  for (const [ticker, shares] of [...holdings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const prices = await historyFor(ticker, historyStart, historyEnd);
      const latest = latestCloseOnOrBefore(prices, today);
      const ytdBase = latestCloseOnOrBefore(prices, ytdTarget);
      const oneYearBase = latestCloseOnOrBefore(prices, oneYearTarget);
      if (!latest) throw new Error("no latest close");
      rows.push({
        ticker,
        shares,
        latestDate: isoDate(latest.date),
        ytdPct: ytdBase ? ((latest.close - ytdBase.close) / ytdBase.close) * 100 : null,
        oneYearPct: oneYearBase ? ((latest.close - oneYearBase.close) / oneYearBase.close) * 100 : null,
        oneYearTotalChange: oneYearBase ? (latest.close - oneYearBase.close) * shares : null,
        totalClose: latest.close * shares,
      });
    } catch (err) {
      failures.push(`${ticker}: ${(err as Error).message}`);
    }
  }

  const table = markdownTable(rows);
  const latestDate = rows[0]?.latestDate ?? "unknown";
  const bodyText = [
    `Stock performance table using latest daily closes through ${latestDate}.`,
    "",
    table,
    "",
    failures.length ? `Missing/failed tickers:\n${failures.map((f) => `- ${f}`).join("\n")}` : "All tickers priced.",
  ].join("\n");
  const bodyHtml = `<div style="font-family:system-ui,sans-serif">
<p>Stock performance table using latest daily closes through ${latestDate}.</p>
${htmlTable(rows)}
${failures.length ? `<p><strong>Missing/failed tickers:</strong></p><ul>${failures.map((f) => `<li>${f}</li>`).join("")}</ul>` : "<p>All tickers priced.</p>"}
</div>`;

  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");

  const result = await sendEmail(session, token, drafts.id, {
    to: [{ email: "willow@vineel.com", name: "Willow" }],
    subject: `Willow: Stock performance table — ${latestDate}`,
    bodyText,
    bodyHtml,
  });

  console.log(JSON.stringify({
    sent: true,
    emailId: result.emailId,
    submissionId: result.submissionId,
    rows: rows.length,
    failures,
    latestDate,
  }, null, 2));
}

await main();
