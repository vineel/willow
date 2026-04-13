import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeWorkerUtils } from "graphile-worker";
import { config } from "../config";

const RETRY_LATER_PATH = join(import.meta.dir, "..", "retry-later.txt");

const content = await readFile(RETRY_LATER_PATH, "utf-8").catch(() => "");
if (!content.trim()) {
  console.log("No entries in retry-later.txt");
  process.exit(0);
}

const filePaths = [...new Set(
  content.trim().split("\n")
    .map((line) => line.split("\t")[1])
    .filter(Boolean)
)];

console.log(`Found ${filePaths.length} unique files to retry`);

const workerUtils = await makeWorkerUtils({ connectionString: config.databaseUrl });

for (const filePath of filePaths) {
  await workerUtils.addJob("ingest_note", { filePath }, {
    jobKey: filePath,
    jobKeyMode: "replace",
    maxAttempts: 1,
  });
}

console.log(`Queued ${filePaths.length} jobs`);
await workerUtils.release();
