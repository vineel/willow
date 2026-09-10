/**
 * Bootstrap foldersort: discover willow-secondary subfolders in Fastmail,
 * upsert app.folder_profile rows for each, and seed descriptions + folder_rule
 * rows from pib/foldersort/seed-taxonomy.ts.
 *
 * Idempotent. Existing non-empty descriptions / llm_hints / rules are NOT
 * overwritten. New subfolders added to Fastmail after the first run get
 * picked up on subsequent runs.
 *
 * Usage:
 *   bun run foldersort:bootstrap
 */

import { sql } from "../config";
import { getSecret } from "../config";
import { getSession, getMailboxes } from "../jmap/session";
import { createLogger } from "../logger";
import { SEED_PROFILES } from "../foldersort/seed-taxonomy";

const log = createLogger("foldersort.bootstrap");
const PARENT_FOLDER = "willow-secondary";

log.runStart(`Bootstrapping foldersort from ${PARENT_FOLDER} subfolders`);

const token = await getSecret("fastmail-token");
const session = await getSession(token);
const mailboxes = await getMailboxes(session, token);

const parent = mailboxes.find((m) => m.name.toLowerCase() === PARENT_FOLDER);
if (!parent) {
  console.error(`ERROR: parent folder "${PARENT_FOLDER}" not found in Fastmail mailboxes.`);
  process.exit(1);
}
log.info(`Parent: ${parent.name} (${parent.id})`);

const children = mailboxes
  .filter((m) => m.parentId === parent.id)
  .sort((a, b) => a.name.localeCompare(b.name));

log.info(`Found ${children.length} direct subfolders:`);
for (const c of children) log.info(`  - ${c.name} (${c.id})`);

const seedByName = new Map(SEED_PROFILES.map((s) => [s.name, s] as const));

let profilesUpserted = 0;
let profilesNewlyCreated = 0;
let rulesInserted = 0;
let rulesSkipped = 0;
const missingFromSeed: string[] = [];
const missingFromFastmail: string[] = [];

for (const folder of children) {
  const seed = seedByName.get(folder.name);
  if (!seed) {
    missingFromSeed.push(folder.name);
    // Still create a profile so it's visible in the catalog; description empty.
    const result = await sql`
      INSERT INTO app.folder_profile (name, mailbox_id, parent_path, description, enabled)
      VALUES (${folder.name}, ${folder.id}, ${PARENT_FOLDER}, '', true)
      ON CONFLICT (name) DO UPDATE SET
        mailbox_id = EXCLUDED.mailbox_id,
        parent_path = EXCLUDED.parent_path,
        updated_at  = now()
      RETURNING (xmax = 0) AS inserted
    `;
    profilesUpserted++;
    if (result[0].inserted) profilesNewlyCreated++;
    continue;
  }

  // Upsert profile. Preserve existing description / llm_hint if already set.
  const result = await sql`
    INSERT INTO app.folder_profile
      (name, mailbox_id, parent_path, description, llm_hint, example_senders, enabled)
    VALUES (
      ${seed.name},
      ${folder.id},
      ${PARENT_FOLDER},
      ${seed.description},
      ${seed.llm_hint ?? null},
      ${seed.example_senders ?? []},
      ${seed.enabled}
    )
    ON CONFLICT (name) DO UPDATE SET
      mailbox_id      = EXCLUDED.mailbox_id,
      parent_path     = EXCLUDED.parent_path,
      description     = CASE WHEN app.folder_profile.description = '' THEN EXCLUDED.description ELSE app.folder_profile.description END,
      llm_hint        = COALESCE(app.folder_profile.llm_hint, EXCLUDED.llm_hint),
      example_senders = CASE WHEN cardinality(app.folder_profile.example_senders) = 0 THEN EXCLUDED.example_senders ELSE app.folder_profile.example_senders END,
      enabled         = EXCLUDED.enabled,
      updated_at      = now()
    RETURNING (xmax = 0) AS inserted
  `;
  profilesUpserted++;
  if (result[0].inserted) profilesNewlyCreated++;

  // Seed rules.
  for (const rule of seed.rules ?? []) {
    const ruleName = `seed:${rule.field}:${rule.operator}:${rule.value}->${seed.name}`;
    const existing = await sql`
      SELECT id FROM app.folder_rule WHERE name = ${ruleName} LIMIT 1
    `;
    if (existing.length > 0) {
      rulesSkipped++;
      continue;
    }
    await sql`
      INSERT INTO app.folder_rule
        (name, field, operator, value, header_name, target_folder, priority, source, confirmed, enabled)
      VALUES (
        ${ruleName},
        ${rule.field},
        ${rule.operator},
        ${rule.value},
        ${rule.header_name ?? null},
        ${seed.name},
        ${rule.priority ?? 10},
        'system',
        false,
        true
      )
    `;
    rulesInserted++;
  }
}

// Detect seed entries with no matching Fastmail folder.
const fastmailNames = new Set(children.map((c) => c.name));
for (const seed of SEED_PROFILES) {
  if (!fastmailNames.has(seed.name)) missingFromFastmail.push(seed.name);
}

log.info(
  `Bootstrap done: ${profilesUpserted} profiles upserted (${profilesNewlyCreated} new), ${rulesInserted} seed rules inserted (${rulesSkipped} skipped, already present)`
);

if (missingFromSeed.length > 0) {
  log.warn(
    `Fastmail subfolders without a seed entry (description will be empty until you set one via update_profile MCP): ${missingFromSeed.join(", ")}`
  );
}
if (missingFromFastmail.length > 0) {
  log.warn(
    `Seed entries with no matching Fastmail folder (skipped): ${missingFromFastmail.join(", ")}`
  );
}

// Show empty-description profiles for follow-up.
const empties = (await sql`
  SELECT name FROM app.folder_profile
  WHERE description = '' AND enabled = true
  ORDER BY name
`) as unknown as { name: string }[];

if (empties.length > 0) {
  console.log("\nProfiles still missing a description (use update_profile to fill in):");
  for (const e of empties) console.log(`  • ${e.name}`);
} else {
  console.log("\nAll enabled profiles have a description.");
}

console.log(
  `\nDone. ${profilesUpserted} profiles, ${rulesInserted} new seed rules.`
);
process.exit(0);
