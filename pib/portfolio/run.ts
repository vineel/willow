/**
 * Portfolio valuation runner — shared between worker cron and CLI script.
 */

import { createLogger } from "../logger";
import { parsePositions } from "./positions";
import { fetchQuotes } from "./quotes";
import { valuatePortfolio, type ValuationResult } from "./valuate";
import { sendPortfolioReport, type ReportVariant } from "./report";

const log = createLogger("pib.portfolio");

const POSITIONS_FILE =
  "/Users/vineel/willow-runtime-workspace/information-sources/all-positions-combined.md";

/**
 * Run the full portfolio valuation pipeline: parse → quote → valuate → notify.
 *
 * @param variant which scheduled run this is (controls whether movers are rendered)
 */
export async function runPortfolioReport(
  variant: ReportVariant = "midday"
): Promise<ValuationResult> {
  const holdings = parsePositions(POSITIONS_FILE);
  log.info(`Parsed ${holdings.length} holdings (${holdings.filter((h) => h.isCash).length} cash)`);

  const tickers = [...new Set(holdings.filter((h) => !h.isCash).map((h) => h.ticker))];
  log.info(`Fetching quotes for ${tickers.length} tickers`);

  const quotes = await fetchQuotes(tickers);
  const result = valuatePortfolio(holdings, quotes);

  await sendPortfolioReport(result, variant);

  return result;
}
