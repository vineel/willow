/**
 * Parse the all-positions-combined.md file into holdings grouped by account.
 * Sibling to positions.ts, which flattens across accounts for the total-value report.
 */

import { readFileSync } from "fs";

export interface AccountHolding {
  ticker: string;
  shares: number;
  isCash: boolean;
  account: string;
}

const STATIC_VALUE_TICKERS = new Set([
  "cash",
  "fcash",
  "spaxx",
  "vanguard target 2035 (02315n600)",
]);

/** Parse the markdown positions file, keeping the per-row account column. */
export function parsePositionsByAccount(filePath: string): AccountHolding[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const holdings: AccountHolding[] = [];

  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    if (line.includes("Ticker Symbol") || line.includes("---")) continue;

    const cols = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    if (cols.length < 3) continue;

    const rawTicker = cols[0];
    const rawSharesOrDollar = cols[1];
    const account = cols[2];
    const tickerLower = rawTicker.toLowerCase();

    if (STATIC_VALUE_TICKERS.has(tickerLower)) {
      const dollars = parseDollar(rawSharesOrDollar);
      if (dollars > 0) {
        holdings.push({ ticker: rawTicker, shares: dollars, isCash: true, account });
      }
      continue;
    }

    const shares = parseNumber(rawSharesOrDollar);
    if (shares > 0) {
      holdings.push({ ticker: rawTicker, shares, isCash: false, account });
    }
  }

  return holdings;
}

function parseDollar(s: string): number {
  return parseFloat(s.replace(/[$,]/g, "")) || 0;
}

function parseNumber(s: string): number {
  if (s === "—" || s === "-") return 0;
  return parseFloat(s.replace(/,/g, "")) || 0;
}
