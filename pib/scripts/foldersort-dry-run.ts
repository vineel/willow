/**
 * Dry-run foldersort for a single email. Prints the decision; writes nothing.
 *
 * Usage:
 *   bun run foldersort:dry-run -- --url <fastmail-url>
 *   bun run foldersort:dry-run -- --id <jmap-email-id>
 *   bun run foldersort:dry-run -- --fact-id <uuid>
 */

import { sql } from "../config";
import { getSecret } from "../config";
import { getSession } from "../jmap/session";
import { getEmails } from "../jmap/query";
import { normalize } from "../normalizer";
import { decide } from "../foldersort/decide";
import { listProfiles } from "../foldersort/profiles";
import { loadActiveRules } from "../foldersort/rules";
import { formatPreviewItem } from "../foldersort/format";
import { sourceNoteToEvent } from "../foldersort/from-source-note";

const FASTMAIL_URL_RE = /\/mail\/[^/]+\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/;

function parseArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return { url: get("--url"), id: get("--id"), factId: get("--fact-id") };
}

const { url, id, factId } = parseArgs();

async function loadEventByFactId(fid: string) {
  const rows = await sql`
    SELECT sn.source_note_id, sn.source_type, sn.source_ref, sn.title, sn.raw_text,
           sn.metadata, sn.received_at, f.fact_id
    FROM app.fact f
    JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
    WHERE f.fact_id = ${fid}
  `;
  if ((rows as unknown as any[]).length === 0) throw new Error(`fact_id ${fid} not found`);
  const r = (rows as unknown as any[])[0];
  return { event: sourceNoteToEvent(r), factId: r.fact_id };
}

async function loadEventByJmapId(jmapId: string) {
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const emails = await getEmails(session, token, [jmapId]);
  if (emails.length === 0) throw new Error(`email ${jmapId} not found`);
  return { event: normalize(emails[0]), factId: "(no fact_id — fetched live)" };
}

function emailIdFromUrl(u: string): string {
  const m = FASTMAIL_URL_RE.exec(u);
  if (!m) throw new Error(`Could not parse Fastmail URL: ${u}`);
  return m[2];
}

let item: Awaited<ReturnType<typeof loadEventByFactId>>;
if (factId) {
  item = await loadEventByFactId(factId);
} else if (id) {
  item = await loadEventByJmapId(id);
} else if (url) {
  item = await loadEventByJmapId(emailIdFromUrl(url));
} else {
  console.error("Usage: foldersort:dry-run -- (--url U | --id I | --fact-id F)");
  process.exit(1);
}

const profiles = await listProfiles(true);
const rules = await loadActiveRules();
const decision = await decide(item.event, { profiles, rules });

console.log(
  formatPreviewItem(
    {
      factId: item.factId,
      event: item.event,
      decision,
      receivedAt: item.event.receivedAt,
    },
    0
  )
);
process.exit(0);
