import { sql } from "../memory/db";

export { sql };

export const pibConfig = {
  // Folders Willow watches/skips
  folders: {
    priority: "for-willow",
    block: "not-for-willow",
    notifications: "willow", // skip during sync
  },
} as const;

/**
 * Get a secret from macOS Keychain.
 * Falls back to environment variable if keychain lookup fails.
 */
export async function getSecret(name: string): Promise<string> {
  // Try keychain first
  try {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", name, "-w"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0 && output.trim()) {
      return output.trim();
    }
  } catch {
    // Keychain lookup failed, fall through to env var
  }

  // Fall back to env var (e.g. FASTMAIL_TOKEN, BRAVE_API_KEY)
  const envKey = name.toUpperCase().replace(/-/g, "_");
  const val = process.env[envKey];
  if (val) return val;

  throw new Error(
    `Secret "${name}" not found in keychain or env var ${envKey}`
  );
}
