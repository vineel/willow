/**
 * Parse the all-positions-combined.md file into structured holdings.
 */

import { readFileSync } from "fs";

export interface Holding {
  ticker: string;
  shares: number;
  isCash: boolean;
}

/**
 * Tickers whose Shares column stores a static dollar value rather than a share count.
 * Covers cash/money-market (Cash, FCASH, SPAXX) and unpriceable holdings
 * (e.g. Collective Investment Trusts in 401(k)s that have no public ticker).
 */
const STATIC_VALUE_TICKERS = new Set([
  "cash",
  "fcash",
  "spaxx",
  "vanguard target 2035 (02315n600)",
]);

/**
 * Parse the markdown positions file.
 * Returns an array of holdings with ticker, shares, and cash flag.
 * Cash-like rows use the dollar value from the file as their "shares" (value in dollars).
 */
export function parsePositions(filePath: string): Holding[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const holdings: Holding[] = [];

  for (const line of lines) {
    // Skip non-table rows
    if (!line.startsWith("|")) continue;
    // Skip header and separator rows
    if (line.includes("Ticker Symbol") || line.includes("---")) continue;

    const cols = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);

    if (cols.length < 3) continue;

    const rawTicker = cols[0];
    const rawSharesOrDollar = cols[1];

    const tickerLower = rawTicker.toLowerCase();

    // Static-value positions (cash + unpriceable holdings): shares column holds the dollar value
    if (STATIC_VALUE_TICKERS.has(tickerLower)) {
      const dollars = parseDollar(rawSharesOrDollar);
      if (dollars > 0) {
        holdings.push({ ticker: rawTicker, shares: dollars, isCash: true });
      }
      continue;
    }

    // Regular positions
    const shares = parseNumber(rawSharesOrDollar);
    if (shares > 0) {
      holdings.push({ ticker: rawTicker, shares, isCash: false });
    }
  }

  return holdings;
}

/** Parse a dollar string like "$253,040.98" → 253040.98 */
function parseDollar(s: string): number {
  return parseFloat(s.replace(/[$,]/g, "")) || 0;
}

/** Parse a number string like "1,270.701" → 1270.701, or "—" → 0 */
function parseNumber(s: string): number {
  if (s === "—" || s === "-") return 0;
  return parseFloat(s.replace(/,/g, "")) || 0;
}
