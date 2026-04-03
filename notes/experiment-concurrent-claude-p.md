# Experiment: Concurrent `claude -p` Under Max Subscription

## Question

What happens when multiple `claude -p` processes run simultaneously under a single Max subscription? Does it rate-limit, queue, error, or work fine?

## Why This Matters

The bridge will spawn `claude -p` subprocesses for agent reasoning requests. If two agents trigger reasoning at the same time (or an agent runs while an interactive channel session is active), we need to know:

1. Can multiple `claude -p` processes run in parallel?
2. Can `claude -p` run while a channel session is active?
3. If there's a concurrency limit, what's the error behavior — queue, fail, or degrade?

If concurrent calls fail hard, the bridge needs a serial queue for all `claude -p` requests. If they're throttled, we need backoff logic. If they work fine, we can keep it simple.

## Setup

No special MCP servers needed. Plain prompts are enough — we're testing concurrency behavior, not tool use.

### Helper script

`concurrent-test.ts`:

```typescript
import { $ } from "bun";

async function timedCall(label: string, prompt: string): Promise<void> {
  const start = Date.now();
  console.error(`[${label}] Starting...`);

  try {
    const raw = await $`claude -p ${prompt} --output-format json`.text();
    const result = JSON.parse(raw);
    const elapsed = Date.now() - start;
    console.log(JSON.stringify({
      label,
      elapsed_ms: elapsed,
      success: result.subtype === "success",
      result_preview: result.result?.substring(0, 100),
      cost_usd: result.total_cost_usd,
      session_id: result.session_id,
    }, null, 2));
  } catch (err: any) {
    const elapsed = Date.now() - start;
    console.log(JSON.stringify({
      label,
      elapsed_ms: elapsed,
      success: false,
      error: err.message?.substring(0, 200),
    }, null, 2));
  }
}

const testName = process.argv[2] || "A";

switch (testName) {
  case "A":
    // Two concurrent claude -p calls
    console.error("=== Test A: Two concurrent claude -p calls ===");
    await Promise.all([
      timedCall("call-1", "What is the capital of France? Reply in one word."),
      timedCall("call-2", "What is the capital of Japan? Reply in one word."),
    ]);
    break;

  case "B":
    // Three concurrent calls
    console.error("=== Test B: Three concurrent claude -p calls ===");
    await Promise.all([
      timedCall("call-1", "What is 2+2? Reply with just the number."),
      timedCall("call-2", "What is 3+3? Reply with just the number."),
      timedCall("call-3", "What is 4+4? Reply with just the number."),
    ]);
    break;

  case "C":
    // Five concurrent calls (stress test)
    console.error("=== Test C: Five concurrent claude -p calls ===");
    await Promise.all(
      [1, 2, 3, 4, 5].map(i =>
        timedCall(`call-${i}`, `What is ${i}+${i}? Reply with just the number.`)
      )
    );
    break;

  case "D":
    // Sequential baseline for comparison
    console.error("=== Test D: Two sequential claude -p calls (baseline) ===");
    await timedCall("seq-1", "What is the capital of France? Reply in one word.");
    await timedCall("seq-2", "What is the capital of Japan? Reply in one word.");
    break;
}
```

## Tests

### Test A: Two concurrent calls

```bash
bun run concurrent-test.ts A
```

**Watch for:**
- Do both succeed?
- Are elapsed times similar (true parallelism) or does one wait for the other (serialized)?
- Any errors about rate limits or session conflicts?

### Test B: Three concurrent calls

```bash
bun run concurrent-test.ts B
```

**Watch for:** Same as A, but looking for the concurrency ceiling.

### Test C: Five concurrent calls (stress)

```bash
bun run concurrent-test.ts C
```

**Watch for:** At what point do calls start failing or being noticeably throttled?

### Test D: Sequential baseline

```bash
bun run concurrent-test.ts D
```

**Purpose:** Compare total elapsed time against Test A. If A takes the same time as D, calls are being serialized somewhere.

### Test E: `claude -p` while channel session is active

This tests whether a `claude -p` call works while a long-running channel session exists in tmux (the interactive path).

```bash
# Terminal 1: Start a channel session (from previous experiments)
tmux new-session -d -s "channel-test" "claude --mcp-config mcp-config.json --dangerously-load-development-channels server:bridge-channel --allowedTools 'mcp__bridge-channel__reply'"

# Terminal 2: Run a claude -p call
claude -p "What is 7+7? Reply with just the number." --output-format json
```

**Pass:** The `-p` call returns normally while the channel session is running.
**Fail:** Error about session conflict or OAuth token contention.

If you don't have the channel setup from previous experiments handy, skip this test — it can be verified naturally during Phase 1 when both paths are running.

## Expected Outcomes

| Outcome | What It Means | Bridge Impact |
|---|---|---|
| All concurrent calls succeed, similar timing | True parallelism, no rate limit hit | Keep it simple — no queue needed |
| Calls succeed but are serialized (one finishes before next starts) | Max sub enforces serial execution | Bridge needs a queue but no error handling |
| Some calls fail with rate limit error | Hard concurrency cap | Bridge needs a bounded queue with backoff |
| Calls succeed but slow down proportionally | Shared throughput budget | Bridge should limit concurrent `-p` processes |
| `-p` fails while channel session is active | Session/token conflict | Bridge must pause channel or serialize all Claude access |

## If Concurrency Is Limited

If we hit a concurrency cap (likely 1-3 based on typical subscription models):

1. **Bridge queues `claude -p` requests** — FIFO queue, configurable max concurrent processes
2. **Agent scripts don't need to know** — the bridge abstracts the queue; from the SDK's perspective, `llm.ask("sonnet", ...)` is just slow when the queue is full
3. **Priority levels** — interactive requests could jump the queue ahead of scheduled agent reasoning

## Time Estimate

~30 minutes. Tests A-D are fast (short prompts). Test E depends on having the channel setup available.
