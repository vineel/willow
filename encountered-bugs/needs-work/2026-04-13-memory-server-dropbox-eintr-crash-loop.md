# Memory server "hanging" on startup was actually a Dropbox-EINTR crash loop

**Date:** 2026-04-13
**Component:** `memory/` server, reconciliation + ingest worker
**Status:** Mitigated, not closed. Retries and timeouts in place; root cause in the worker→process error propagation path is still open.

---

## The reported symptom

> The memory server sometimes hangs during the reconciliation scan at startup — it prints `[reconciliation] Scanning...` and then doesn't proceed for minutes. When run manually it completes in ~1 second for 360 files.

That's how todo #2 (`08f26549-...`) was written. Everyone — me included — read that and thought: "slow filesystem traversal, probably Dropbox FileProvider being slow to `stat()` 360 files one at a time."

## What it actually was

A **crash loop**, not a hang. The memory server is managed by launchd (`~/Library/LaunchAgents/com.vineel.willow-memory.plist`) with:
- `KeepAlive=true`
- `ThrottleInterval=10` (10-second respawn throttle)

When the process crashes, launchd waits 10 seconds and respawns it. From the outside — watching stdout — this looks *exactly* like a hang:

```
[memory] Starting Willow Memory Server...
[reconciliation] Scanning /Users/vineel/Dropbox/VineelerNotes for missed files...
(10 seconds of silence)
[memory] Starting Willow Memory Server...
[reconciliation] Scanning /Users/vineel/Dropbox/VineelerNotes for missed files...
(10 seconds of silence)
...
```

The actual log (`/tmp/willow-memory.log`) showed **15 fatal crashes across 22 starts**, all the same error:

```
[memory] Fatal error: EINTR: interrupted system call, open '/Users/vineel/Dropbox/VineelerNotes
    path: "/Users/vineel/Dropbox/VineelerNotes\u0000",
 syscall: "open",
   errno: -4,
    code: "EINTR"
```

Three things worth noting about that error:

1. **The failing `open` is on `notesRoot` itself**, not a file inside it. So it's not the per-file stat loop I was suspecting — it's `Glob.scan({ cwd: notesRoot })` calling `opendir` on the root directory.

2. **errno -4 / `EINTR`.** `open(2)` got interrupted by a signal. On macOS, Dropbox's FileProvider extension can return EINTR from filesystem syscalls when the extension is waking up, materializing online-only files, or being throttled by Dropbox. Bun's native glob/opendir wrapper does **not** auto-retry EINTR, so a single EINTR propagates as a fatal JS error.

3. **The `\u0000` at the end of the path in the error object** is a red herring. It's almost certainly a Bun cosmetic bug — the C-level path string's NUL terminator leaking into the `path` field of the JS error object when formatting `opendir` failures. The real bug is the unretried EINTR. (Worth a Bun upstream bug report; not load-bearing for the fix.)

### A secondary issue uncovered

The log also showed two ingest tasks that had run for **huge** durations before erroring out:

```
Failed task 27928 (ingest_note, 1719532.39ms, attempt 1 of 3)
  with error 'EINTR: ... open inbox/accordli/todo/2026-04-10-brave-search-api-acct.md'
Failed task 27930 (ingest_note, 1789768.14ms, attempt 1 of 3)
  with error 'EINTR: ... open searches/2026-02-10T18-23-14-search.md'
```

That's **28 minutes** and **29 minutes** respectively, blocked inside `Bun.file(path).exists()` / `.text()` on a Dropbox-managed file. This happens when the FileProvider extension can't materialize an online-only file (extension wedged, Dropbox offline, or throttled) — the `open(2)` call just blocks indefinitely. Normal apps show a beachball; background workers silently hang until something signals them.

## How the misdiagnosis happened

The todo description was written by someone watching the symptom from the outside. "Prints `Scanning...` then silence for minutes" is indistinguishable from:
- **Hypothesis A** (what we believed): slow sequential `stat()` calls on Dropbox FileProvider
- **Hypothesis B** (actual): crash loop with 10s launchd throttle + FileProvider EINTR

Both produce the same observable: a banner, then silence, then eventually something else. The difference is only visible in the actual log file — which we weren't reading because we thought we knew what the bug was.

**Lesson:** When a bug description gives you a symptom + a theory ("it hangs — probably Dropbox slowness"), don't skip checking the actual log for exit codes and stack traces. A `launchctl list` showing `"LastExitStatus" = 9` would have told us "this is crashing, not hanging" in about ten seconds. I only found it after making a first-pass fix that didn't actually touch the crash path.

**Also:** there was a crucial piece of context buried in the history — the `NOTES_ROOT` env var was originally misconfigured (pointed at `/dev/null` or similar). That was fixed by setting it to `~/Dropbox/VineelerNotes`. With the old value, reconciliation's `glob.scan` never touched the Dropbox FileProvider mount, so the latent EINTR bug was asleep. The fix is what **exposed** the bug, not what caused it. Reverting would hide, not solve.

## The first-pass fix (which was wrong-target but still good)

Before I found the real cause, I made a change based on Hypothesis A:

> Parallelize the sequential stat loop in `reconciliationScan` with 16-way bounded concurrency, add per-file slow-stat logging (>500ms), and progress ticks every 25 files.

This is a fine change on its own merits:
- Bounds worst-case wall time from O(n × slowest_stat) to O(ceil(n/16) × slowest_stat)
- Gives us diagnostic output so we can see *where* things stall

But it didn't touch `glob.scan` itself, which is where the actual crash was happening. I confirmed the fix "worked" by restarting the server twice and seeing successful runs — which just meant Dropbox happened to be in a good state during my testing. The bug was latent, not fixed.

**Lesson:** "I restarted it and it worked" is not a fix confirmation when the bug is intermittent. You need to either reproduce the failure mode first and then confirm it's gone, or instrument the specific failing code path.

## The real fix

Two changes in `memory/watcher/watch.ts` and one in `memory/worker/tasks.ts`:

### 1. EINTR-retry helpers in `watch.ts`

Three small helpers at the top of the file:

```ts
function isEINTR(err: unknown): boolean { ... }

async function enumerateMarkdownFiles(notesRoot, logPrefix): Promise<string[]> {
  // Wraps `new Glob("**/*.md").scan({ cwd: notesRoot })` in a 5-attempt retry
  // loop with linear backoff (200ms × attempt) on EINTR.
}

async function statWithRetry(fullPath): Promise<{ mtime: number }> {
  // Wraps Bun.file(path).stat() in a 3-attempt retry loop (100ms × attempt)
  // on EINTR.
}
```

Both `reconciliationScan` and `startWatcher.poll()` now use these helpers. Critically, if enumeration exhausts retries, they **log and return** instead of throwing — a failed reconciliation should not kill the whole memory server.

### 2. Timeout on ingest file reads in `tasks.ts`

```ts
const FILE_READ_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> { ... }

// in ingestNote:
const exists = await withTimeout(file.exists(), FILE_READ_TIMEOUT_MS, `exists(${short})`);
const rawText = await withTimeout(file.text(), FILE_READ_TIMEOUT_MS, `read(${short})`);
```

On timeout, the task throws. graphile-worker catches task throws as normal task failures and retries up to `maxAttempts=3`. No more 28-minute zombies.

## What's still outstanding — why this is in `needs-work/`

1. **Worker task error → fatal process error propagation is still a mystery.** The log shows `[worker(...)] ERROR: Failed task N` (graphile-worker caught the task throw) *and* `[memory] Fatal error:` (something promoted it to fatal) back-to-back. Now that the reconciliation EINTR is retried, this propagation path may be dormant, but the containment gap is still real. I haven't traced where in `memory/server.ts` a worker task error can escape to the top level.

2. **The fix hasn't been tested against a real FileProvider-wedged state.** Both restarts I did after the fix succeeded — but Dropbox wasn't misbehaving at the time, so I don't have empirical evidence the retry loop actually recovers from EINTR. The next organic "Dropbox is busy" moment will be the real test. Watch `/tmp/willow-memory.log` for lines matching `glob.scan EINTR \(attempt N/5\)`. If those appear and the scan still completes, the fix works. If they appear and the enumeration fails with "Enumeration failed after retries", the retry budget needs to grow.

3. **Bun upstream bug** for the `\u0000` in `error.path` on `opendir` failures — low urgency, worth filing.

4. **`startWatcher.poll()` also does sequential stats** (unchanged by this fix — only its glob.scan got retried). If the same per-file Dropbox slowness ever surfaces in polling, the poll will stall for minutes at a time. Worth parallelizing with `statWithRetry` + bounded concurrency, same pattern as reconciliation.

---

## Learnings to carry forward

- **Launchd + KeepAlive + ThrottleInterval makes crash loops look like hangs.** Any component running under launchd needs its log examined before you accept a "it's hanging" diagnosis. `launchctl list <label>` and look at `LastExitStatus`.

- **Bug descriptions carry assumptions.** The todo said "hangs during reconciliation scan." I took that at face value and spent the first round of work optimizing the stat loop — which was irrelevant. Always separate *observation* ("silence after the Scanning log") from *interpretation* ("therefore the scan is slow"). The observation was correct; the interpretation was wrong.

- **"I restarted and it worked" is not a fix validation for intermittent bugs.** Need to either reproduce the failure first or directly instrument the code path that was failing.

- **Dropbox FileProvider on macOS returns `EINTR` from filesystem syscalls.** Any Bun/Node code that touches `~/Dropbox/...` and doesn't retry EINTR is a latent crash waiting for Dropbox to get busy. This will come up again — other parts of Willow touch this mount (the PIB pipeline, potentially future agents). Consider making EINTR-retry a shared utility.

- **Configuration changes can expose latent bugs without causing them.** The `NOTES_ROOT=/dev/null` → `~/Dropbox/VineelerNotes` change didn't create the crash; it moved reconciliation from a path that didn't hit FileProvider to one that did. When debugging, always ask: "was this bug possible before the last config change, or did that change wake something up?"

- **Parallelizing sequential filesystem loops is a cheap reliability win on slow/unreliable filesystems** even when it doesn't fix a specific bug. The 16-way concurrent stat phase is still valuable; it just wasn't the answer to todo #2.

## Files touched

- `memory/watcher/watch.ts` — EINTR retry helpers, rewrote `reconciliationScan` and `startWatcher.poll()` to use them; added stat-failure counting to progress output
- `memory/worker/tasks.ts` — `withTimeout` helper; wrapped `file.exists()` and `file.text()` calls in `ingestNote`
- `app.todo` row `08f26549-af55-4bcd-b143-424fccc4ba8a` — description rewritten with real diagnosis and next-steps list
