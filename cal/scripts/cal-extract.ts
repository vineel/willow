import { runCalExtraction } from "../extract";
import { createLogger } from "../../pib/logger";

const log = createLogger("cal.cli");

async function main() {
  log.runStart("Manual calendar extraction");
  console.log("Running calendar extraction...\n");

  const result = await runCalExtraction();

  console.log("Extraction results:");
  console.log(`  Processed: ${result.processed}`);
  console.log(`  Errors: ${result.errors}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
