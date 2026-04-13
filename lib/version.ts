/**
 * Version info helper — writes a JSON file on process startup so we can
 * verify which code revision is running for each Willow service.
 *
 * Usage:
 *   import { writeVersionInfo } from "../lib/version";
 *   await writeVersionInfo("worker");   // writes /tmp/willow-worker-version.json
 */

interface VersionInfo {
  service: string;
  gitCommit: string;
  gitDirty: boolean;
  gitBranch: string;
  startedAt: string;
  pid: number;
  entryPoint: string;
}

async function run(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: "/Users/vineel/aidev/willow" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return "";
  }
}

export async function writeVersionInfo(service: string): Promise<VersionInfo> {
  const [gitCommit, gitDirtyOutput, gitBranch] = await Promise.all([
    run(["git", "rev-parse", "--short", "HEAD"]),
    run(["git", "status", "--porcelain"]),
    run(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  const info: VersionInfo = {
    service,
    gitCommit: gitCommit || "unknown",
    gitDirty: gitDirtyOutput.length > 0,
    gitBranch: gitBranch || "unknown",
    startedAt: new Date().toISOString(),
    pid: process.pid,
    entryPoint: process.argv[1] ?? "unknown",
  };

  const path = `/tmp/willow-${service}-version.json`;
  await Bun.write(path, JSON.stringify(info, null, 2) + "\n");

  const dirtyMark = info.gitDirty ? " (dirty)" : "";
  console.log(`[version] ${service} running ${info.gitCommit}${dirtyMark} on ${info.gitBranch} — ${path}`);

  return info;
}
