/**
 * Portfolio valuation runner — shared between worker cron and CLI script.
 */

import { createLogger } from "../logger";
import { parsePositions } from "./positions";
import { fetchQuotes } from "./quotes";
import { valuatePortfolio, type ValuationResult } from "./valuate";
import { sendPortfolioReport, type ReportVariant } from "./report";
import { recordValuation } from "./storage";

const log = createLogger("pib.portfolio");

const POSITIONS_FILE =
  "/Users/vineel/willow-runtime-workspace/information-sources/all-positions-combined.md";

/**
 * Run the full portfolio valuation pipeline: parse → quote → valuate → notify.
 *
 * @param variant which scheduled run this is (controls whether movers are rendered)
 * @param options.dryRun if true, skip sending the report email (CLI lookups)
 */
export async function runPortfolioReport(
  variant: ReportVariant = "midday",
  options: { dryRun?: boolean } = {}
): Promise<ValuationResult> {
  const holdings = parsePositions(POSITIONS_FILE);
  log.info(`Parsed ${holdings.length} holdings (${holdings.filter((h) => h.isCash).length} cash)`);

  const tickers = [...new Set(holdings.filter((h) => !h.isCash).map((h) => h.ticker))];
  log.info(`Fetching quotes for ${tickers.length} tickers`);

  const quotes = await fetchQuotes(tickers);
  const result = valuatePortfolio(holdings, quotes);

  if (options.dryRun) {
    log.info("Dry run — skipping report send");
  } else {
    await recordValuation(variant, result);
    await sendPortfolioReport(result, variant);
  }

  return result;
}
