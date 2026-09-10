// Correspondent list — addresses Vineel has emailed (sent-mail scan) or
// manually whitelisted. The DB (app.correspondent) is the source of truth.
// `data/correspondents.txt` is a regenerated audit dump.

import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { sql } from "../config";

export const CORRESPONDENT_FILE = resolve(
  import.meta.dir,
  "../../data/correspondents.txt"
);

function norm(addr: string): string {
  return addr.trim().toLowerCase();
}

export async function isKnownCorrespondent(address: string): Promise<boolean> {
  const a = norm(address);
  if (!a) return false;
  const rows = await sql`
    SELECT 1 FROM app.correspondent WHERE address = ${a} LIMIT 1
  `;
  return rows.length > 0;
}

export async function addCorrespondent(
  address: string,
  note?: string | null
): Promise<{ inserted: boolean }> {
  const a = norm(address);
  if (!a) throw new Error("address required");
  const result = await sql`
    INSERT INTO app.correspondent (address, source, note)
    VALUES (${a}, 'manual', ${note ?? null})
    ON CONFLICT (address) DO UPDATE SET
      source       = 'manual',
      note         = COALESCE(EXCLUDED.note, app.correspondent.note),
      last_seen_at = now()
    RETURNING (xmax = 0) AS inserted
  `;
  await regenerateFile();
  return { inserted: result[0].inserted };
}

export async function removeCorrespondent(address: string): Promise<boolean> {
  const a = norm(address);
  if (!a) return false;
  const result = await sql`
    DELETE FROM app.correspondent WHERE address = ${a} RETURNING address
  `;
  if (result.length > 0) {
    await regenerateFile();
    return true;
  }
  return false;
}

export async function listCorrespondents(contains?: string): Promise<
  { address: string; source: string; note: string | null; first_seen: Date; last_seen_at: Date }[]
> {
  const pattern = contains ? `%${contains.toLowerCase()}%` : null;
  if (pattern) {
    return (await sql`
      SELECT address, source, note, first_seen, last_seen_at
      FROM app.correspondent
      WHERE address LIKE ${pattern}
      ORDER BY address
    `) as unknown as ReturnType<typeof listCorrespondents> extends Promise<infer T> ? T : never;
  }
  return (await sql`
    SELECT address, source, note, first_seen, last_seen_at
    FROM app.correspondent
    ORDER BY address
  `) as unknown as ReturnType<typeof listCorrespondents> extends Promise<infer T> ? T : never;
}

// Bulk upsert from a scan. Bumps last_seen_at for existing rows.
// Returns counts: { inserted, updated }.
export async function upsertScanned(
  addresses: Iterable<string>
): Promise<{ inserted: number; updated: number; total: number }> {
  const normalized = Array.from(new Set(Array.from(addresses, norm).filter((a) => a)));
  if (normalized.length === 0) {
    await regenerateFile();
    return { inserted: 0, updated: 0, total: 0 };
  }

  // Build a VALUES list. postgres.js handles parameterization for arrays via .values()
  // We'll use a single statement with an unnest pattern for efficiency.
  const result = await sql`
    INSERT INTO app.correspondent (address, source)
    SELECT a, 'scan' FROM unnest(${normalized}::text[]) AS t(a)
    ON CONFLICT (address) DO UPDATE SET
      last_seen_at = now()
    RETURNING (xmax = 0) AS inserted
  `;
  const inserted = result.filter((r: any) => r.inserted).length;
  const updated = result.length - inserted;
  await regenerateFile();
  return { inserted, updated, total: result.length };
}

// Regenerate the audit file from the DB. Cheap; called after every mutation.
export async function regenerateFile(): Promise<{ path: string; lines: number }> {
  const rows = (await sql`
    SELECT address FROM app.correspondent ORDER BY address
  `) as unknown as { address: string }[];
  mkdirSync(dirname(CORRESPONDENT_FILE), { recursive: true });
  const body = rows.map((r) => r.address).join("\n") + (rows.length > 0 ? "\n" : "");
  writeFileSync(CORRESPONDENT_FILE, body, "utf8");
  return { path: CORRESPONDENT_FILE, lines: rows.length };
}
