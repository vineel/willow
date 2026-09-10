/**
 * Persistence for portfolio valuations — used to compare snapshots over time
 * (e.g. post-close vs. Monday pre-market for the Week's Change section).
 */

import { sql } from "../config";
import { createLogger } from "../logger";
import type { ReportVariant } from "./report";
import type { ValuationResult } from "./valuate";

const log = createLogger("pib.portfolio.storage");

export interface ValuationSnapshot {
  ts: Date;
  variant: ReportVariant;
  totalValue: number;
}

export async function recordValuation(
  variant: ReportVariant,
  result: ValuationResult
): Promise<void> {
  await sql`
    INSERT INTO app.portfolio_valuation (variant, total_value, valued_count, missing_count)
    VALUES (${variant}, ${result.totalValue}, ${result.valuedCount}, ${result.missing.length})
  `;
  log.info(`Recorded ${variant} valuation: $${result.totalValue.toFixed(2)}`);
}

/**
 * Most recent Monday in America/New_York at 00:00:00 ET (inclusive of today
 * if today is Monday). Returned as a UTC Date suitable for SQL comparison.
 */
function mondayStartOfWeekET(now: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "numeric",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value])
  );
  const weekday = parts.weekday;
  const daysSinceMonday = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[weekday] ?? 0;

  const yyyy = Number(parts.year);
  const mm = Number(parts.month);
  const dd = Number(parts.day);
  const noonUtc = Date.UTC(yyyy, mm - 1, dd, 12, 0, 0);
  const mondayNoonUtc = noonUtc - daysSinceMonday * 24 * 60 * 60 * 1000;

  const mondayDateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "numeric",
  });
  const mp = Object.fromEntries(
    mondayDateFmt.formatToParts(new Date(mondayNoonUtc)).map((p) => [p.type, p.value])
  );

  const month = String(mp.month).padStart(2, "0");
  const day = String(mp.day).padStart(2, "0");
  return new Date(`${mp.year}-${month}-${day}T05:00:00Z`);
}

/**
 * Earliest pre-market valuation on or after Monday of the current ET week.
 * Returns null if no pre-market run has been recorded yet this week (e.g. the
 * first post-close after this feature shipped, or a Monday holiday before the
 * Tue pre-market run lands).
 */
export async function getWeekBaselinePremarket(
  now: Date = new Date()
): Promise<ValuationSnapshot | null> {
  const mondayStart = mondayStartOfWeekET(now);

  const rows = await sql<Array<{ ts: Date; variant: string; total_value: string }>>`
    SELECT ts, variant, total_value
    FROM app.portfolio_valuation
    WHERE variant = 'premarket'
      AND ts >= ${mondayStart}
      AND ts <= ${now}
    ORDER BY ts ASC
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ts: r.ts,
    variant: r.variant as ReportVariant,
    totalValue: Number(r.total_value),
  };
}
