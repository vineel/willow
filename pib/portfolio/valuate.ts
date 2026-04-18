/**
 * Calculate total portfolio value from holdings and quotes.
 */

import type { Holding } from "./positions";
import type { QuoteMap } from "./quotes";
import { createLogger } from "../logger";

const log = createLogger("pib.portfolio.valuate");

/** Tickers that should always appear in the "North Stars" section. */
export const NORTH_STAR_TICKERS = ["AAPL", "NVDA"] as const;

/** Absolute percent move (since previous close) required to qualify as a Big Mover. */
export const BIG_MOVER_THRESHOLD_PCT = 2;

export interface TickerMove {
  ticker: string;
  price: number;
  /** Dollar change in price vs. previous close */
  priceChange: number;
  /** Percent change vs. previous close (e.g. 3.4 for +3.4%) */
  pctChange: number;
}

export interface ValuationResult {
  totalValue: number;
  /** Tickers we couldn't price (excluded from total) */
  missing: string[];
  /** Number of holdings valued */
  valuedCount: number;
  /** North Star tickers we hold, with current price and day change. */
  northStars: TickerMove[];
  /** Tickers we hold that moved more than ±BIG_MOVER_THRESHOLD_PCT since prev close. */
  bigMovers: TickerMove[];
}

/**
 * Compute total portfolio value + per-ticker moves.
 * - Cash holdings: shares field already holds dollar value.
 * - Regular holdings: shares × price from QuoteMap.
 * - Missing quotes: logged and excluded.
 */
export function valuatePortfolio(
  holdings: Holding[],
  quotes: QuoteMap
): ValuationResult {
  let totalValue = 0;
  const missing: string[] = [];
  let valuedCount = 0;
  const heldTickers = new Set<string>();

  for (const h of holdings) {
    if (h.isCash) {
      totalValue += h.shares;
      valuedCount++;
      continue;
    }

    const quote = quotes.get(h.ticker);
    if (quote == null) {
      missing.push(h.ticker);
      continue;
    }

    totalValue += h.shares * quote.price;
    valuedCount++;
    heldTickers.add(h.ticker);
  }

  const moves: TickerMove[] = [];
  for (const ticker of heldTickers) {
    const q = quotes.get(ticker);
    if (!q || q.prevClose == null || q.prevClose === 0) continue;
    const priceChange = q.price - q.prevClose;
    const pctChange = (priceChange / q.prevClose) * 100;
    moves.push({ ticker, price: q.price, priceChange, pctChange });
  }

  const northStars = NORTH_STAR_TICKERS.flatMap((t) => {
    const m = moves.find((x) => x.ticker === t);
    return m ? [m] : [];
  });

  const northStarSet = new Set(NORTH_STAR_TICKERS as readonly string[]);
  const bigMovers = moves
    .filter((m) => !northStarSet.has(m.ticker) && Math.abs(m.pctChange) >= BIG_MOVER_THRESHOLD_PCT)
    .sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

  if (missing.length > 0) {
    log.warn(`Missing quotes for: ${missing.join(", ")}`);
  }

  log.info(
    `Valued ${valuedCount} holdings, total: $${totalValue.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}, ${bigMovers.length} big movers`
  );

  return { totalValue, missing, valuedCount, northStars, bigMovers };
}
