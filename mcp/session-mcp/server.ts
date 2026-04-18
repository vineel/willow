#!/usr/bin/env bun
/**
 * MCP server for Claude Code session lifecycle.
 * Lets a Slack-triggered tool call restart the session — clears context and
 * reloads MCP server code.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const TMUX_SESSION = "willow-agent";
const TMUX_PANE = `${TMUX_SESSION}:0.0`;
const RELAUNCH_SCRIPT = "/Users/vineel/willow-runtime-workspace/relaunch-claude.sh";
const LOG_FILE = "/tmp/willow-runtime.log";

function log(msg: string) {
  const line = `${new Date().toISOString()}  INFO   [mcp.session]  ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort
  }
  process.stderr.write(line);
}

const server = new McpServer(
  { name: "willow-session", version: "0.1.0" },
  {
    instructions: [
      "Use restart_session to clear the current Claude Code conversation context and reload all MCP server code.",
      "The restart happens ~3 seconds after the tool returns so the response reaches the user first.",
      "tmux session 'willow-agent' stays alive; only the claude process is respawned in-place.",
      "Memory files, the memory DB, and other MCP databases persist across the restart.",
    ].join(" "),
  }
);

server.tool(
  "restart_session",
  "Restart the Claude Code session running in the 'willow-agent' tmux pane. Clears conversation context and reloads MCP server code. The restart fires ~3s after this call returns so the response is delivered first. The tmux session stays alive — only the claude process is respawned. Memory files and MCP databases persist. After restart, the user continues in a fresh session.",
  {
    reason: z
      .string()
      .optional()
      .describe("Why the restart was requested — recorded in /tmp/willow-runtime.log"),
  },
  async ({ reason }) => {
    log(`restart_session requested${reason ? `: ${reason}` : ""}`);

    // Detach a subprocess that sleeps, then respawns the pane. It must be detached
    // because the `tmux respawn-pane -k` call kills the claude process that hosts
    // this MCP server — a foreground child would die with us before respawn.
    const cmd = `sleep 3 && tmux respawn-pane -k -t ${TMUX_PANE} ${RELAUNCH_SCRIPT}`;
    const child = spawn("bash", ["-c", cmd], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const text = [
      "Restart scheduled.",
      `  target pane: ${TMUX_PANE}`,
      `  fires in:    ~3s`,
      `  reason:      ${reason ?? "(not specified)"}`,
      "",
      "The claude process will exit and respawn. Context will be cleared; memory files and MCP databases persist.",
    ].join("\n");

    return {
      content: [{ type: "text", text }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
