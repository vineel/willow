import { pibConfig } from "./config";
import { addBlockRule, addAllowRule } from "./triage/rules";
import type { CanonicalEvent } from "./jmap/types";

export type SignalAction = "process" | "block" | "skip" | "normal";

/**
 * Determine how to handle an email based on which folder it came from.
 */
export function classifyFolder(folderName: string): SignalAction {
  const lower = folderName.toLowerCase();

  if (lower === pibConfig.folders.notifications) return "skip";
  if (lower === pibConfig.folders.priority) return "process";
  if (lower === pibConfig.folders.block) return "block";
  return "normal";
}

/**
 * Handle a signal folder email:
 * - for-willow: create allowlist rule for the sender
 * - not-for-willow: create blocklist rule for the sender
 *
 * Returns the created rule ID (or undefined if rule already existed).
 */
export async function handleSignalFolder(
  event: CanonicalEvent,
  action: "process" | "block"
): Promise<{ ruleId?: string; address: string }> {
  const address = event.fromEntity.address;

  if (action === "block") {
    const ruleId = await addBlockRule(address, "user");
    return { ruleId, address };
  }

  // action === "process"
  const ruleId = await addAllowRule(address, "user");
  return { ruleId, address };
}
