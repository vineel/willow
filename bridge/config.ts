import { resolve } from "path";

export const config = {
  port: 8787,
  host: "0.0.0.0",

  channelHttpPort: 8788,

  projectRoot: resolve(import.meta.dir, ".."),

  pool: {
    minSessions: 1,
    maxSessions: 1, // start with 1 to avoid multi-port coordination
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    spawnCooldownMs: 10_000,
    requestTimeoutMs: 2 * 60 * 1000,
    managementIntervalMs: 60_000,
    spawnReadyDelayMs: 12_000, // wait for Claude Code startup + tool discovery
    confirmDelayMs: 2_000, // wait before sending "y" to accept dev channels
  },

  claudeP: {
    timeoutMs: 120_000,
  },
} as const;
