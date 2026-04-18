/**
 * Helpers to schedule Graphile Worker crons in America/New_York time.
 *
 * Graphile Worker cron runs strictly in UTC, so an ET-local time like "8 AM"
 * maps to a different UTC hour depending on DST (EDT = UTC-4, EST = UTC-5).
 * `etCronItems` emits two slots covering both shifts; `inEasternHour` guards
 * the handler so only the slot matching the current ET hour actually runs.
 */

export type EtCronSpec = {
  task: string;
  identifier: string;
  hour: number;
  minute?: number;
  dayOfWeek?: string;
  payload?: Record<string, unknown>;
};

export type CronItem = {
  task: string;
  match: string;
  identifier: string;
  payload?: Record<string, unknown>;
};

export function etCronItems(spec: EtCronSpec): CronItem[] {
  const minute = spec.minute ?? 0;
  const dow = spec.dayOfWeek ?? "*";
  const edtUtcHour = (spec.hour + 4) % 24;
  const estUtcHour = (spec.hour + 5) % 24;

  return [
    {
      task: spec.task,
      match: `${minute} ${edtUtcHour} * * ${dow}`,
      identifier: `${spec.identifier}_edt`,
      payload: { ...spec.payload, __etHour: spec.hour },
    },
    {
      task: spec.task,
      match: `${minute} ${estUtcHour} * * ${dow}`,
      identifier: `${spec.identifier}_est`,
      payload: { ...spec.payload, __etHour: spec.hour },
    },
  ];
}

export function currentEtHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour === "24" ? 0 : parseInt(hour ?? "0", 10);
}

export function inEasternHour(expectedHour: number): boolean {
  return currentEtHour() === expectedHour;
}
