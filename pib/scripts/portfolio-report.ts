/**
 * Portfolio Valuation Report — fetch quotes, calculate total, send notification.
 *
 * Usage: bun run pib:portfolio [variant] [--dry-run]
 *   variant: premarket | midday (default) | postclose
 *   --dry-run: compute and print the total but skip sending the email
 *              (use this for ad-hoc CLI lookups; the cron path always sends)
 */

import { createLogger } from "../logger";
import { runPortfolioReport } from "../portfolio/run";
import type { ReportVariant } from "../portfolio/report";

const log = createLogger("pib.portfolio");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const validVariants: ReportVariant[] = ["premarket", "midday", "postclose"];
const variant: ReportVariant =
  positional[0] && validVariants.includes(positional[0] as ReportVariant)
    ? (positional[0] as ReportVariant)
    : "midday";

log.runStart(`Portfolio valuation report (manual, ${variant}${dryRun ? ", dry-run" : ""})`);

try {
  const result = await runPortfolioReport(variant, { dryRun });

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
