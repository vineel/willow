import { Glob } from "bun";
import { sql } from "../db";
import type { WorkerUtils } from "graphile-worker";

const POLL_INTERVAL_MS = 60_000;

// Dropbox FileProvider on macOS can return EINTR from opendir/open/stat when
// the extension is busy (sync, materializing online-only files, wake-up).
// Bun does not auto-retry EINTR, so we wrap filesystem calls ourselves.
function isEINTR(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "EINTR") return true;
  return err.message.includes("EINTR");
}

async function enumerateMarkdownFiles(
  notesRoot: string,
  logPrefix: string,
): Promise<string[]> {
  const MAX_RETRIES = 5;
  const BACKOFF_MS = 200;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const glob = new Glob("**/*.md");
      const paths: string[] = [];
      for await (const relPath of glob.scan({ cwd: notesRoot })) {
        paths.push(`${notesRoot}/${relPath}`);
      }
      return paths;
    } catch (err) {
      if (isEINTR(err) && attempt < MAX_RETRIES) {
        const wait = BACKOFF_MS * attempt;
        console.log(
          `${logPrefix} glob.scan EINTR (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait}ms`,
        );
        await Bun.sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${logPrefix} glob.scan: exhausted retries`);
}

async function statWithRetry(fullPath: string): Promise<{ mtime: number }> {
  const MAX_RETRIES = 3;
  const BACKOFF_MS = 100;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stat = await Bun.file(fullPath).stat();
      return { mtime: stat.mtime.getTime() };
    } catch (err) {
      if (isEINTR(err) && attempt < MAX_RETRIES) {
        await Bun.sleep(BACKOFF_MS * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error("statWithRetry: unreachable");
}

interface FileState {
  mtime: number;
}

export function startWatcher(notesRoot: string, workerUtils: WorkerUtils) {
  const knownFiles = new Map<string, FileState>();
  let initialized = false;

  async function poll() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    const currentFiles = new Map<string, FileState>();

    let added = 0;
    let changed = 0;
    let removed = 0;

    let paths: string[];
    try {
      paths = await enumerateMarkdownFiles(notesRoot, "[watcher]");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[watcher] Skipping poll — enumeration failed: ${msg}`);
      return;
    }

    for (const fullPath of paths) {
      let mtime: number;
      try {
        ({ mtime } = await statWithRetry(fullPath));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[watcher] stat failed for ${fullPath}: ${msg} — skipping`);
        continue;
      }
      currentFiles.set(fullPath, { mtime });

      const prev = knownFiles.get(fullPath);
      if (!prev) {
        if (initialized) {
          console.log(`[watcher] New file: ${fullPath}`);
          await enqueueNote(fullPath, workerUtils);
          added++;
        }
      } else if (prev.mtime !== mtime) {
        console.log(`[watcher] Changed file: ${fullPath}`);
        await enqueueNote(fullPath, workerUtils);
        changed++;
      }
    }

    // Detect deletions
    if (initialized) {
      for (const [path] of knownFiles) {
        if (!currentFiles.has(path)) {
          console.log(`[watcher] Removed file: ${path}`);
          await deactivateNote(path);
          removed++;
        }
      }
    }

    // Replace known state
    knownFiles.clear();
    for (const [k, v] of currentFiles) knownFiles.set(k, v);

    if (!initialized) {
      console.log(`[watcher] Initial scan: ${currentFiles.size} files`);
      initialized = true;
    } else {
      console.log(`[watcher] Poll ${timeStr} — ${added} new, ${changed} updated, ${removed} deleted`);
    }
  }

  // Run first poll immediately, then on interval
  poll().catch((err) => console.error("[watcher] Initial poll failed:", err));
  const timer = setInterval(
    () => poll().catch((err) => console.error("[watcher] Poll failed:", err)),
    POLL_INTERVAL_MS,
  );

  console.log(`[watcher] Watching ${notesRoot}/**/*.md (polling every ${POLL_INTERVAL_MS / 1000}s)`);

  return {
    close: async () => {
      clearInterval(timer);
    },
  };
}

async function enqueueNote(filePath: string, workerUtils: WorkerUtils) {
  await workerUtils.addJob("ingest_note", { filePath }, {
    jobKey: filePath,
    jobKeyMode: "replace",
    maxAttempts: 3,
  });
}

async function deactivateNote(filePath: string) {
  const existing = await sql`
    SELECT source_note_id FROM app.source_note
    WHERE filename = ${filePath}
    LIMIT 1
  `;

  if (existing.length === 0) return;

  const sourceNoteId = existing[0].source_note_id;

  const [result] = await sql`
    UPDATE app.fact
    SET is_active = false, updated_at = now()
    WHERE source_note_id = ${sourceNoteId} AND is_active = true
    RETURNING count(*) OVER () AS deactivated
  `;

  const count = result?.deactivated ?? 0;
  console.log(`[watcher] Deactivated ${count} facts for removed file: ${filePath}`);
}

export async function reconciliationScan(notesRoot: string, workerUtils: WorkerUtils) {
  console.log(`[reconciliation] Scanning ${notesRoot} for missed files...`);

  const filesOnDisk = new Map<string, number>(); // fullPath -> mtime

  // 1a. Enumerate paths (with EINTR retry — Dropbox FileProvider can return
  //     EINTR on opendir; Bun does not auto-retry).
  const scanStart = Date.now();
  let paths: string[];
  try {
    paths = await enumerateMarkdownFiles(notesRoot, "[reconciliation]");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[reconciliation] Enumeration failed after retries — skipping reconciliation this startup: ${msg}`,
    );
    return;
  }
  console.log(
    `[reconciliation] Enumerated ${paths.length} paths in ${Date.now() - scanStart}ms`,
  );

  // 1b. Stat files with bounded concurrency + per-file slow-stat logging +
  //     EINTR retry. Sequential awaited stats on Dropbox can stall per file
  //     when the extension is busy; parallelizing bounds worst-case wall time
  //     to O(ceil(n/concurrency) * slowest).
  const CONCURRENCY = 16;
  const SLOW_STAT_MS = 500;
  const PROGRESS_EVERY = 25;
  let done = 0;
  let slowCount = 0;
  let statFailures = 0;
  const statStart = Date.now();

  async function statOne(fullPath: string) {
    const t0 = Date.now();
    try {
      const { mtime } = await statWithRetry(fullPath);
      const elapsed = Date.now() - t0;
      if (elapsed > SLOW_STAT_MS) {
        slowCount++;
        console.log(`[reconciliation] Slow stat (${elapsed}ms): ${fullPath}`);
      }
      filesOnDisk.set(fullPath, mtime);
    } catch (err) {
      statFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[reconciliation] Stat failed: ${fullPath} — ${msg}`);
    }
    done++;
    if (done % PROGRESS_EVERY === 0) {
      console.log(
        `[reconciliation] Progress: ${done}/${paths.length} (${Date.now() - statStart}ms elapsed, ${slowCount} slow, ${statFailures} failed)`,
      );
    }
  }

  for (let i = 0; i < paths.length; i += CONCURRENCY) {
    const batch = paths.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(statOne));
  }

  console.log(
    `[reconciliation] Found ${filesOnDisk.size} files on disk (stat phase: ${Date.now() - statStart}ms, ${slowCount} slow, ${statFailures} failed)`,
  );

  // 2. Single batch query — get all known source_notes under this root
  const dbRows = await sql`
    SELECT filename, created_at
    FROM app.source_note
    WHERE filename LIKE ${notesRoot + '/%'}
  `;
  const dbFiles = new Map<string, Date>();
  for (const row of dbRows) {
    dbFiles.set(row.filename, row.created_at);
  }

  // 3. Diff: find files that need ingestion
  let queued = 0;
  for (const [fullPath, mtime] of filesOnDisk) {
    const dbCreatedAt = dbFiles.get(fullPath);
    const needsIngest = !dbCreatedAt || mtime > dbCreatedAt.getTime();
    if (needsIngest) {
      await workerUtils.addJob("ingest_note", { filePath: fullPath }, {
        jobKey: fullPath,
        jobKeyMode: "replace",
        maxAttempts: 3,
      });
      queued++;
    }
  }

  // 4. Diff: deactivate facts for files no longer on disk
  const orphanedFiles: string[] = [];
  for (const [filename] of dbFiles) {
    if (!filesOnDisk.has(filename)) {
      orphanedFiles.push(filename);
    }
  }

  if (orphanedFiles.length > 0) {
    await sql`
      UPDATE app.fact
      SET is_active = false, updated_at = now()
      WHERE source_note_id IN (
        SELECT source_note_id FROM app.source_note WHERE filename = ANY(${orphanedFiles})
      ) AND is_active = true
    `;
    for (const f of orphanedFiles) {
      console.log(`[reconciliation] Deactivated facts for removed file: ${f}`);
    }
  }

  console.log(`[reconciliation] Queued ${queued} files, deactivated ${orphanedFiles.length} orphaned entries`);
}
