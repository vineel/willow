/**
 * Portfolio Detail Snapshot — live per-ticker $ values, grouped by account, with
 * account-level and overall totals. Read-only CLI lookup; never sends a report email.
 *
 * Usage: bun run pib:portfolio:detail [--by-ticker]
 *   --by-ticker: pivot to ticker rows x account columns, with row/column totals
 *                (all cash-like holdings — Cash, FCASH, SPAXX, CASH — collapse into one "Cash" row)
 */

import { createLogger } from "../logger";
import { parsePositionsByAccount } from "../portfolio/positions-by-account";
import { fetchQuotes } from "../portfolio/quotes";

const log = createLogger("pib.portfolio.detail");

const POSITIONS_FILE =
  "/Users/vineel/willow-runtime-workspace/information-sources/all-positions-combined.md";

const argv = process.argv.slice(2);
const byTicker = argv.includes("--by-ticker");
const asJson = argv.includes("--json");

const fmt = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

interface ValuedRow {
  ticker: string;
  account: string;
  shares: number;
  price: number | null;
  value: number | null;
  isCash: boolean;
}

try {
  const holdings = parsePositionsByAccount(POSITIONS_FILE);
  log.info(`Parsed ${holdings.length} holdings across accounts`);

  const tickers = [...new Set(holdings.filter((h) => !h.isCash).map((h) => h.ticker))];
  const quotes = await fetchQuotes(tickers);

  const rows: ValuedRow[] = holdings.map((h) => {
    if (h.isCash) {
      return { ticker: "Cash", account: h.account, shares: h.shares, price: null, value: h.shares, isCash: true };
    }
    const q = quotes.get(h.ticker);
    const value = q ? h.shares * q.price : null;
    return { ticker: h.ticker, account: h.account, shares: h.shares, price: q?.price ?? null, value, isCash: false };
  });

  const grandTotal = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const grandMissing = rows.filter((r) => !r.isCash && r.value == null).length;

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows, grandTotal, grandMissing }, null, 2));
    process.exit(0);
  }

  console.log(`\nPortfolio Detail Snapshot — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}\n`);

  if (byTicker) {
    const accounts = [...new Set(rows.map((r) => r.account))];
    const tickerOrder = [...new Set(rows.map((r) => r.ticker))].filter((t) => t !== "Cash");
    tickerOrder.push("Cash");

    for (const ticker of tickerOrder) {
      const cells = rows.filter((r) => r.ticker === ticker);
      const rowTotal = cells.reduce((sum, r) => sum + (r.value ?? 0), 0);
      console.log(`${ticker.padEnd(30)} ${fmt(rowTotal).padStart(14)}  (${accounts.filter((a) => cells.some((c) => c.account === a)).join(", ")})`);
    }
    console.log(`\n${"TOTAL".padEnd(30)} ${fmt(grandTotal).padStart(14)}`);
  } else {
    const byAccount = new Map<string, ValuedRow[]>();
    for (const r of rows) {
      const lines = byAccount.get(r.account) ?? [];
      lines.push(r);
      byAccount.set(r.account, lines);
    }

    for (const [account, lines] of byAccount) {
      console.log(`## ${account}`);
      let accountTotal = 0;
      for (const l of lines) {
        const valueStr = l.value != null ? fmt(l.value) : "(no quote)";
        const shareStr = l.isCash ? "" : `  ${l.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })} sh @ ${l.price != null ? "$" + l.price.toFixed(2) : "?"}`;
        console.log(`  ${l.ticker.padEnd(12)} ${valueStr.padStart(14)}${shareStr}`);
        if (l.value != null) accountTotal += l.value;
      }
      console.log(`  ${"Account total".padEnd(12)} ${fmt(accountTotal).padStart(14)}\n`);
    }

    console.log(`## Overall`);
    console.log(`  Total across all accounts: ${fmt(grandTotal)}`);
  }

  if (grandMissing > 0) {
    console.log(`  (${grandMissing} holding(s) missing a quote — excluded from totals)`);
  }
} catch (err) {
  log.error(`Portfolio detail failed: ${(err as Error).message}`);
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
}
