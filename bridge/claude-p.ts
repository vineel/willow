import { $ } from "bun";
import { config } from "./config.js";

export interface ClaudePOptions {
  prompt: string;
  sessionId?: string; // for --resume multi-turn
  mcpConfig?: string; // path to MCP config for tool access
  timeoutMs?: number;
}

export interface ClaudePResult {
  type: string;
  subtype: string;
  result: string;
  session_id: string;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
}

export async function runClaudeP(
  options: ClaudePOptions
): Promise<ClaudePResult> {
  const args = ["-p", options.prompt, "--output-format", "json"];

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }
  if (options.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }

  const timeout = options.timeoutMs ?? config.claudeP.timeoutMs;

  const proc = Bun.spawn(["claude", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  });

  // Race between process completion and timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`claude -p timed out after ${timeout}ms`));
    }, timeout);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `claude -p exited with code ${exitCode}: ${stderr.slice(0, 500)}`
      );
    }

    return JSON.parse(stdout) as ClaudePResult;
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}
