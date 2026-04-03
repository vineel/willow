export type SessionStatus = "idle" | "busy" | "stale" | "dead";

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  created: number;
  lastUsed: number;
  currentRequestId: string | null;
  channelPort: number;
}

export interface PoolConfig {
  minSessions: number;
  maxSessions: number;
  sessionIdleTimeoutMs: number;
  spawnCooldownMs: number;
  requestTimeoutMs: number;
  managementIntervalMs: number;
  spawnReadyDelayMs: number;
  confirmDelayMs: number;
}

export interface PoolStatus {
  sessions: Array<{
    sessionId: string;
    status: SessionStatus;
    created: string;
    lastUsed: string;
    currentRequestId: string | null;
  }>;
  totalSessions: number;
  idleSessions: number;
  busySessions: number;
}
