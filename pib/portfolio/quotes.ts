/**
 * Fetch stock/fund quotes from Yahoo Finance.
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
import { createLogger } from "../logger";

const log = createLogger("pib.portfolio.quotes");

export interface Quote {
  price: number;
  prevClose: number | null;
}

/** Ticker → quote mapping */
export type QuoteMap = Map<string, Quote>;

/**
 * Known ticker aliases for symbols Yahoo Finance doesn't recognize directly.
 * Map from our positions file ticker → Yahoo Finance symbol.
 */
const TICKER_ALIASES: Record<string, string> = {};

/**
 * Fetch quotes for a list of tickers.
 * Returns a map of ticker → {price, prevClose}. Tickers that fail are logged and omitted.
 */
export async function fetchQuotes(tickers: string[]): Promise<QuoteMap> {
  const quotes: QuoteMap = new Map();

  const toFetch: Array<{ original: string; symbol: string }> = [];

  for (const ticker of tickers) {
    const symbol = TICKER_ALIASES[ticker] ?? ticker;
    toFetch.push({ original: ticker, symbol });
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async ({ original, symbol }) => {
        const result = await yahooFinance.quote(symbol);
        const price = result.regularMarketPrice;
        if (price == null) {
          throw new Error(`No price returned for ${symbol}`);
        }
        const prevClose = result.regularMarketPreviousClose ?? null;
        return { original, price, prevClose };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        quotes.set(result.value.original, {
          price: result.value.price,
          prevClose: result.value.prevClose,
        });
      } else {
        log.error(`Quote fetch failed: ${result.reason}`);
      }
    }
  }

  log.info(`Fetched ${quotes.size}/${tickers.length} quotes`);
  return quotes;
}
