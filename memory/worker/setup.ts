import { run, type TaskList } from "graphile-worker";
import { config } from "../config";
import { tasks } from "./tasks";

export async function startWorker() {
  const runner = await run({
    connectionString: config.databaseUrl,
    concurrency: 1,
    noHandleSignals: true, // we handle shutdown ourselves
    taskList: tasks as TaskList,
  });

  console.log(`[worker] Graphile Worker started (concurrency: 1)`);

  return runner;
}
