/**
 * Portfolio Valuation Report — fetch quotes, calculate total, send notification.
 *
 * Usage: bun run pib:portfolio [variant]
 *   variant: premarket | midday (default) | postclose
 */

import { createLogger } from "../logger";
import { runPortfolioReport } from "../portfolio/run";
import type { ReportVariant } from "../portfolio/report";

const log = createLogger("pib.portfolio");

const arg = process.argv[2];
const validVariants: ReportVariant[] = ["premarket", "midday", "postclose"];
const variant: ReportVariant =
  arg && validVariants.includes(arg as ReportVariant) ? (arg as ReportVariant) : "midday";

log.runStart(`Portfolio valuation report (manual, ${variant})`);

try {
  const result = await runPortfolioReport(variant);

  const total = "$" + result.totalValue.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  console.log(`\nPortfolio value: ${total} (${result.valuedCount} holdings valued, ${result.bigMovers.length} big movers)`);
  if (result.missing.length > 0) {
    console.log(`Missing quotes: ${result.missing.join(", ")}`);
  }
} catch (err) {
  log.error(`Portfolio report failed: ${(err as Error).message}`);
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
}
