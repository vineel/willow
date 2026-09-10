// Scan Vineel's "sent" mailbox and upsert recipient addresses into
// app.correspondent. Called by the CLI (one-time bootstrap) and the Graphile
// Worker cron (daily incremental). Returns counts for the caller to log.

import { getSecret } from "../config";
import { getSession, getMailboxes } from "../jmap/session";
import { jmapRequest } from "../jmap/client";
import { createLogger } from "../logger";
import { upsertScanned, CORRESPONDENT_FILE } from "./correspondents";

const log = createLogger("foldersort.scan-sent");
const PAGE = 50;

interface JMAPAddress { name: string | null; email: string }
interface JMAPRecipientEmail {
  id: string;
  to: JMAPAddress[] | null;
  cc: JMAPAddress[] | null;
  bcc: JMAPAddress[] | null;
  sentAt: string | null;
}

export function sinceToIso(spec: string): string {
  const m = /^(\d+)([dwmy])$/.exec(spec);
  if (!m) throw new Error(`--since must look like 365d, 12w, 3m, 1y (got "${spec}")`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === "d" ? n * 86400e3
           : unit === "w" ? n * 7 * 86400e3
           : unit === "m" ? n * 30 * 86400e3
           : /* y */        n * 365 * 86400e3;
  return new Date(Date.now() - ms).toISOString();
}

export interface ScanSentResult {
  since: string;
  afterIso: string;
  idsCollected: number;
  emailsSeen: number;
  inserted: number;
  updated: number;
  total: number;
  filePath: string;
}

export async function runScanSent(since: string): Promise<ScanSentResult> {
  const afterIso = sinceToIso(since);
  log.runStart(`scan-sent since=${since} (after=${afterIso})`);

  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const sent = mailboxes.find((m) => m.role === "sent");
  if (!sent) throw new Error("Sent mailbox not found");
  log.info(`Sent mailbox: "${sent.name}" (${sent.id})`);

  const allIds: string[] = [];
  let position = 0;
  while (true) {
    const resp = await jmapRequest(session.apiUrl, token, [
      [
        "Email/query",
        {
          accountId: session.accountId,
          filter: { inMailbox: sent.id, after: afterIso },
          sort: [{ property: "sentAt", isAscending: false }],
          position,
          limit: PAGE,
          calculateTotal: position === 0,
        },
        "q1",
      ],
    ]);
    const [methodName, result] = resp.methodResponses[0];
    if (methodName === "error") {
      throw new Error(`Email/query failed: ${JSON.stringify(result)}`);
    }
    const ids = (result as any).ids as string[];
    const total = (result as any).total as number | undefined;
    if (position === 0 && typeof total === "number") {
      log.info(`Total sent emails matching filter: ${total}`);
    }
    if (ids.length === 0) break;
    allIds.push(...ids);
    log.info(`Fetched IDs page position=${position} count=${ids.length} (running total ${allIds.length})`);
    if (ids.length < PAGE) break;
    position += PAGE;
  }

  log.info(`Total IDs collected: ${allIds.length}`);

  const addresses = new Set<string>();
  let emailsSeen = 0;

  for (let i = 0; i < allIds.length; i += PAGE) {
    const batch = allIds.slice(i, i + PAGE);
    const resp = await jmapRequest(session.apiUrl, token, [
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: batch,
          properties: ["id", "to", "cc", "bcc", "sentAt"],
        },
        "g1",
      ],
    ]);
    const [methodName, result] = resp.methodResponses[0];
    if (methodName === "error") {
      throw new Error(`Email/get failed: ${JSON.stringify(result)}`);
    }
    const list = (result as any).list as JMAPRecipientEmail[];
    for (const e of list) {
      emailsSeen++;
      for (const recip of [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])]) {
        if (recip?.email) addresses.add(recip.email.trim().toLowerCase());
      }
    }
    log.info(`Processed batch ${i / PAGE + 1}/${Math.ceil(allIds.length / PAGE)} — running unique addresses: ${addresses.size}`);
  }

  const { inserted, updated, total } = await upsertScanned(addresses);
  log.info(
    `Upserted ${total} addresses (${inserted} new, ${updated} bumped) from ${emailsSeen} sent emails (last ${since}); file regenerated → ${CORRESPONDENT_FILE}`
  );

  return {
    since,
    afterIso,
    idsCollected: allIds.length,
    emailsSeen,
    inserted,
    updated,
    total,
    filePath: CORRESPONDENT_FILE,
  };
}
