import type { PoolConfig, PoolStatus, SessionState } from "./types.js";
import * as tmux from "./tmux.js";

export class SessionPool {
  private sessions = new Map<string, SessionState>();
  private managementTimer: ReturnType<typeof setInterval> | null = null;
  private nextSessionNumber = 1;
  private lastSpawnTime = 0;
  private poolConfig: PoolConfig;
  private channelHttpPort: number;
  private projectRoot: string;
  private log: (...args: unknown[]) => void;

  constructor(
    poolConfig: PoolConfig,
    appConfig: { channelHttpPort: number; projectRoot: string }
  ) {
    this.poolConfig = poolConfig;
    this.channelHttpPort = appConfig.channelHttpPort;
    this.projectRoot = appConfig.projectRoot;
    this.log = (...args) => console.log("[pool]", ...args);
  }

  async start(): Promise<void> {
    this.log("Starting session pool...");

    // Clean up any leftover willow sessions from a previous run
    const existing = await tmux.listWillowSessions();
    for (const id of existing) {
      this.log(`Killing leftover session: ${id}`);
      await tmux.killSession(id);
    }

    // Spawn minimum sessions
    for (let i = 0; i < this.poolConfig.minSessions; i++) {
      await this.spawnNewSession();
    }

    // Start management loop
    this.managementTimer = setInterval(
      () => this.managementLoop(),
      this.poolConfig.managementIntervalMs
    );

    this.log(`Pool started with ${this.sessions.size} session(s)`);
  }

  async stop(): Promise<void> {
    if (this.managementTimer) {
      clearInterval(this.managementTimer);
      this.managementTimer = null;
    }

    for (const [id] of this.sessions) {
      await tmux.killSession(id);
    }
    this.sessions.clear();
    this.log("Pool stopped");
  }

  async acquireSession(requestId: string): Promise<SessionState | null> {
    // Find an idle session (prefer most recently used for warm context)
    let best: SessionState | null = null;
    for (const session of this.sessions.values()) {
      if (session.status === "idle") {
        if (!best || session.lastUsed > best.lastUsed) {
          best = session;
        }
      }
    }

    if (!best) {
      // Try to spawn if below max
      if (this.sessions.size < this.poolConfig.maxSessions) {
        const canSpawn =
          Date.now() - this.lastSpawnTime >= this.poolConfig.spawnCooldownMs;
        if (canSpawn) {
          best = await this.spawnNewSession();
        }
      }
    }

    if (!best) return null;

    best.status = "busy";
    best.currentRequestId = requestId;
    best.lastUsed = Date.now();
    return best;
  }

  releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "idle";
      session.currentRequestId = null;
      session.lastUsed = Date.now();
    }
  }

  getStatus(): PoolStatus {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      status: s.status,
      created: new Date(s.created).toISOString(),
      lastUsed: new Date(s.lastUsed).toISOString(),
      currentRequestId: s.currentRequestId,
    }));

    return {
      sessions,
      totalSessions: sessions.length,
      idleSessions: sessions.filter((s) => s.status === "idle").length,
      busySessions: sessions.filter((s) => s.status === "busy").length,
    };
  }

  private async spawnNewSession(): Promise<SessionState> {
    const id = tmux.sessionName(this.nextSessionNumber++);
    const port = this.channelHttpPort; // single port for now (maxSessions=1)

    this.log(`Spawning session ${id} on channel port ${port}...`);

    await tmux.spawnSession(
      id,
      this.projectRoot,
      port,
      this.poolConfig.confirmDelayMs,
      this.poolConfig.spawnReadyDelayMs
    );

    this.lastSpawnTime = Date.now();

    const state: SessionState = {
      sessionId: id,
      status: "idle",
      created: Date.now(),
      lastUsed: Date.now(),
      currentRequestId: null,
      channelPort: port,
    };

    this.sessions.set(id, state);
    this.log(`Session ${id} is ready`);
    return state;
  }

  private async managementLoop(): Promise<void> {
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      // Check if tmux session is still alive
      const alive = await tmux.hasSession(id);
      if (!alive) {
        this.log(`Session ${id} is dead, removing from pool`);
        this.sessions.delete(id);
        continue;
      }

      // Mark stuck sessions as stale
      if (
        session.status === "busy" &&
        now - session.lastUsed > this.poolConfig.requestTimeoutMs
      ) {
        this.log(`Session ${id} is stuck, marking stale`);
        session.status = "stale";
        await tmux.killSession(id);
        this.sessions.delete(id);
        continue;
      }

      // Kill idle sessions past TTL (only if above minimum)
      if (
        session.status === "idle" &&
        this.sessions.size > this.poolConfig.minSessions &&
        now - session.lastUsed > this.poolConfig.sessionIdleTimeoutMs
      ) {
        this.log(`Session ${id} idle too long, killing`);
        await tmux.killSession(id);
        this.sessions.delete(id);
      }
    }

    // Spawn replacements if below minimum
    const idleCount = Array.from(this.sessions.values()).filter(
      (s) => s.status === "idle"
    ).length;
    const total = this.sessions.size;

    if (total < this.poolConfig.minSessions) {
      const canSpawn =
        now - this.lastSpawnTime >= this.poolConfig.spawnCooldownMs;
      if (canSpawn) {
        this.log("Below minimum sessions, spawning replacement...");
        await this.spawnNewSession();
      }
    }
  }
}
