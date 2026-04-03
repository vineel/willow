import { $ } from "bun";
import { resolve } from "path";

const SESSION_PREFIX = "willow-";

export function sessionName(n: number): string {
  return `${SESSION_PREFIX}${n}`;
}

export async function spawnSession(
  sessionId: string,
  projectRoot: string,
  channelPort: number,
  confirmDelayMs: number,
  readyDelayMs: number
): Promise<void> {
  const mcpConfig = resolve(projectRoot, "mcp-config.json");
  const debugFile = `/tmp/claude-debug-${sessionId}.log`;

  // The claude command to run inside the tmux session
  const claudeCmd = [
    `cd ${projectRoot}`,
    "&&",
    "claude",
    `--mcp-config ${mcpConfig}`,
    "--dangerously-load-development-channels server:bridge-channel",
    `--allowedTools "mcp__bridge-channel__reply"`,
    `--debug-file ${debugFile}`,
  ].join(" ");

  // Create detached tmux session running claude
  await $`tmux new-session -d -s ${sessionId} ${claudeCmd}`.quiet();

  // Wait for Claude Code to show the dev channels confirmation prompt
  await Bun.sleep(confirmDelayMs);

  // Accept the confirmation prompt (it's a selection menu with option 1 pre-selected, just press Enter)
  await $`tmux send-keys -t ${sessionId} Enter`.quiet();

  // Wait for Claude Code to fully initialize and discover tools
  await Bun.sleep(readyDelayMs);
}

export async function hasSession(sessionId: string): Promise<boolean> {
  try {
    await $`tmux has-session -t ${sessionId}`.quiet();
    return true;
  } catch {
    return false;
  }
}

export async function killSession(sessionId: string): Promise<void> {
  try {
    await $`tmux kill-session -t ${sessionId}`.quiet();
  } catch {
    // Session may already be dead
  }
}

export async function capturePane(sessionId: string): Promise<string> {
  try {
    return await $`tmux capture-pane -t ${sessionId} -p -S -80`.text();
  } catch {
    return "";
  }
}

export async function listWillowSessions(): Promise<string[]> {
  try {
    const output =
      await $`tmux list-sessions -F '#{session_name}' 2>/dev/null`.text();
    return output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith(SESSION_PREFIX));
  } catch {
    return [];
  }
}
