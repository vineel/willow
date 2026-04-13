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
  version: string;
  gitCommit: string;
  gitDirty: boolean;
  gitBranch: string;
  startedAt: string;
  pid: number;
  entryPoint: string;
}

async function readPackageVersion(): Promise<string> {
  try {
    const pkg = await Bun.file("/Users/vineel/aidev/willow/package.json").json();
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
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
  const [version, gitCommit, gitDirtyOutput, gitBranch] = await Promise.all([
    readPackageVersion(),
    run(["git", "rev-parse", "--short", "HEAD"]),
    run(["git", "status", "--porcelain"]),
    run(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  const info: VersionInfo = {
    service,
    version,
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
  console.log(`[version] ${service} v${info.version} (${info.gitCommit}${dirtyMark}) on ${info.gitBranch} — ${path}`);

  return info;
}
