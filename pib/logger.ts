/**
 * Structured logger for Willow runtime.
 * Writes to /tmp/willow-runtime.log with a parseable format.
 *
 * Format:
 *   2026-04-10T19:30:00.123Z  INFO  [pib.ingest]  Fetched 10 emails from inbox
 *   2026-04-10T19:30:00.456Z  WARN  [pib.classify]  LM Studio not available
 *
 * Run separators: 2 blank lines between runs for readability.
 */

import { appendFileSync } from "fs";

const LOG_FILE = "/tmp/willow-runtime.log";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_PAD: Record<LogLevel, string> = {
  DEBUG: "DEBUG",
  INFO:  "INFO ",
  WARN:  "WARN ",
  ERROR: "ERROR",
};

function formatLine(level: LogLevel, component: string, message: string): string {
  const ts = new Date().toISOString();
  return `${ts}  ${LEVEL_PAD[level]}  [${component}]  ${message}\n`;
}

function write(level: LogLevel, component: string, message: string): void {
  const line = formatLine(level, component, message);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // If log file can't be written, fall through to stderr
  }
  // Also write to stderr so Graphile Worker logger captures it
  process.stderr.write(line);
}

export function debug(component: string, message: string): void {
  write("DEBUG", component, message);
}

export function info(component: string, message: string): void {
  write("INFO", component, message);
}

export function warn(component: string, message: string): void {
  write("WARN", component, message);
}

export function error(component: string, message: string): void {
  write("ERROR", component, message);
}

/**
 * Write a run separator — 2 blank lines + a header line.
 * Call this at the start of each pipeline run or digest run.
 */
export function runStart(component: string, description: string): void {
  const ts = new Date().toISOString();
  const separator = `\n\n${ts}  -----  [${component}]  ${description}  -----\n`;
  try {
    appendFileSync(LOG_FILE, separator);
  } catch {}
  process.stderr.write(separator);
}

/**
 * Create a scoped logger for a component.
 */
export function createLogger(component: string) {
  return {
    debug: (msg: string) => debug(component, msg),
    info: (msg: string) => info(component, msg),
    warn: (msg: string) => warn(component, msg),
    error: (msg: string) => error(component, msg),
    runStart: (desc: string) => runStart(component, desc),
  };
}
