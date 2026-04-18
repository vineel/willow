import { runCalSync } from "../sync";
import { runCalExtraction } from "../extract";
import { createLogger } from "../../pib/logger";

const log = createLogger("cal.cli");

async function main() {
  log.runStart("Manual calendar sync");
  console.log("Starting calendar sync...\n");

  const stats = await runCalSync();

  console.log("Sync results:");
  console.log(`  Calendars discovered: ${stats.calendarsDiscovered}`);
  console.log(`  Calendars skipped (unchanged): ${stats.calendarsSkipped}`);
  console.log(`  Events created: ${stats.eventsCreated}`);
  console.log(`  Events updated: ${stats.eventsUpdated}`);
  console.log(`  Events deleted: ${stats.eventsDeleted}`);
  console.log(`  Extraction enqueued: ${stats.extractionEnqueued}`);
  console.log(`  Errors: ${stats.errors}`);

  if (stats.extractionEnqueued > 0) {
    console.log(`\nRunning extraction on ${stats.extractionEnqueued} events...`);
    const extractResult = await runCalExtraction();
    console.log(`  Processed: ${extractResult.processed}`);
    console.log(`  Errors: ${extractResult.errors}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
