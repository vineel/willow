import { Glob } from "bun";
import { sql } from "../db";
import type { WorkerUtils } from "graphile-worker";

const POLL_INTERVAL_MS = 60_000;

interface FileState {
  mtime: number;
}

export function startWatcher(notesRoot: string, workerUtils: WorkerUtils) {
  const knownFiles = new Map<string, FileState>();
  let initialized = false;

  async function poll() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    const glob = new Glob("**/*.md");
    const currentFiles = new Map<string, FileState>();

    let added = 0;
    let changed = 0;
    let removed = 0;

    for await (const relPath of glob.scan({ cwd: notesRoot })) {
      const fullPath = `${notesRoot}/${relPath}`;
      const file = Bun.file(fullPath);
      const stat = await file.stat();
      const mtime = stat.mtime.getTime();
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

  const glob = new Glob("**/*.md");
  const filesOnDisk = new Map<string, number>(); // fullPath -> mtime

  // 1. Scan disk in one pass — collect all paths and mtimes
  for await (const relPath of glob.scan({ cwd: notesRoot })) {
    const fullPath = `${notesRoot}/${relPath}`;
    const file = Bun.file(fullPath);
    const stat = await file.stat();
    filesOnDisk.set(fullPath, stat.mtime.getTime());
  }

  console.log(`[reconciliation] Found ${filesOnDisk.size} files on disk`);

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
