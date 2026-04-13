// Fragmented-dossier reparent sweep — failure mode 3 from
// notes/person-dedupe-strategy.md §6.
//
// Detects clusters of 3+ active facts sharing a possessive prefix
// ("X's ...") and attaches them to an existing factoid named `X` via
// parent_factoid_id. If no parent exists, creates one (type = Unknown).
//
//   bun run memory/scripts/reparent-fragments.ts              # dry-run
//   bun run memory/scripts/reparent-fragments.ts --apply      # write
//
// Run AFTER cleanup-factoid-types.ts and dedupe-factoids.ts so that the
// parent factoid count reflects the post-dedupe state.

import { sql } from "../db";
import { normalizeTitle } from "../dedupe/normalize";

const APPLY = process.argv.includes("--apply");

interface FragmentRow {
  fact_id: string;
  title: string;
  parent_factoid_id: string | null;
}

// 1. Possessive-prefix fragment detection. Apostrophe required — "address"
//    and "business" are NOT possessives of Addres/Busines.
const POSSESSIVE_RE = String.raw`^(\w+)'s\s`;
const REPLACE_RE = String.raw`^(\w+)'s\s.*`;

const prefixRows = await sql<Array<{ prefix: string; fragments: number }>>`
  SELECT lower(regexp_replace(title, ${REPLACE_RE}, ${"\\1"})) AS prefix,
         count(*)::int AS fragments
  FROM app.fact
  WHERE is_active = true
    AND title ~ ${POSSESSIVE_RE}
  GROUP BY prefix
  HAVING count(*) >= 3
  ORDER BY count(*) DESC
`;

console.log("");
console.log(`=== Fragment reparent sweep (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
console.log(`Found ${prefixRows.length} prefix clusters`);
console.log("");

interface Plan {
  prefix: string;
  parent: { fact_id: string; title: string | null; factoid_type: string | null } | null;
  createParent: boolean;
  fragments: FragmentRow[];
}
const plans: Plan[] = [];

for (const row of prefixRows) {
  // Load the fragments in this cluster.
  const fragments = await sql<FragmentRow[]>`
    SELECT fact_id, title, parent_factoid_id
    FROM app.fact
    WHERE is_active = true
      AND lower(regexp_replace(title, ${REPLACE_RE}, ${"\\1"})) = ${row.prefix}
      AND title ~ ${POSSESSIVE_RE}
  `;

  // Find the best parent factoid: active, is_factoid=true, normalized title
  // starts with the prefix. Prefer human-verified then most children.
  const parentCandidates = await sql<
    Array<{
      fact_id: string;
      title: string | null;
      factoid_type: string | null;
      human_verified: boolean;
      child_count: number;
    }>
  >`
    SELECT f.fact_id, f.title, f.factoid_type, f.human_verified,
           (SELECT count(*)::int FROM app.fact c WHERE c.parent_factoid_id = f.fact_id AND c.is_active = true) AS child_count
    FROM app.fact f
    WHERE f.is_active = true
      AND f.is_factoid = true
      AND lower(f.title) LIKE ${row.prefix + "%"}
    ORDER BY f.human_verified DESC, f.created_at ASC
    LIMIT 5
  `;

  // Require the parent candidate's bare title (lowercased, possessive
  // stripped, punctuation cleaned) to EQUAL the prefix. We don't use the
  // full normalizer here because its suffix stripper would turn a fragment
  // like "Brad's Background and Role" into "brad", falsely qualifying it
  // as a parent for other Brad fragments.
  const bareTitle = (t: string | null): string => {
    if (!t) return "";
    return t
      .toLowerCase()
      .replace(/'s\b/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  let chosen: Plan["parent"] = null;
  for (const c of parentCandidates) {
    if (bareTitle(c.title) === row.prefix) {
      chosen = { fact_id: c.fact_id, title: c.title, factoid_type: c.factoid_type };
      break;
    }
  }

  plans.push({
    prefix: row.prefix,
    parent: chosen,
    createParent: chosen === null,
    fragments,
  });
}

// 2. Print the plan.
let reparentCount = 0;
let createCount = 0;
for (const p of plans) {
  const tag = p.createParent
    ? `CREATE parent "${p.prefix}" (Unknown)`
    : `PARENT ${p.parent?.title} [${p.parent?.factoid_type}]`;
  console.log(`[${p.fragments.length} fragments] prefix=${p.prefix} → ${tag}`);
  for (const f of p.fragments.slice(0, 6)) {
    const alreadyCorrect =
      !p.createParent && f.parent_factoid_id === p.parent?.fact_id;
    const mark = alreadyCorrect ? "   ∙" : "  ->";
    console.log(`${mark} ${f.title}`);
    if (!alreadyCorrect) reparentCount++;
  }
  if (p.fragments.length > 6) {
    const unset = p.fragments
      .slice(6)
      .filter((f) => p.createParent || f.parent_factoid_id !== p.parent?.fact_id).length;
    console.log(`     ... +${p.fragments.length - 6} more (${unset} to reparent)`);
    reparentCount += unset;
  }
  if (p.createParent) createCount++;
  console.log("");
}

console.log(`Plan: create ${createCount} parent(s), reparent ${reparentCount} fragment(s)`);
console.log("");

if (!APPLY) {
  console.log("Dry-run only. Re-run with --apply to write.");
  await sql.end();
  process.exit(0);
}

// 3. Apply.
await sql.begin(async (tx) => {
  for (const p of plans) {
    let parentId: string;

    if (p.createParent) {
      // Capitalize first letter for display.
      const displayTitle =
        p.prefix.charAt(0).toUpperCase() + p.prefix.slice(1);
      const [created] = await tx<Array<{ fact_id: string }>>`
        INSERT INTO app.fact
          (title, content, is_factoid, factoid_type, memory_type, status)
        VALUES (
          ${displayTitle},
          ${`Auto-created parent factoid for orphaned ${p.prefix}'s ... fragments.`},
          true,
          'Unknown',
          'long_term',
          'clustered'
        )
        RETURNING fact_id
      `;
      parentId = created.fact_id;
      console.log(`CREATED parent ${displayTitle} (${parentId})`);
    } else {
      parentId = p.parent!.fact_id;
    }

    for (const f of p.fragments) {
      if (f.parent_factoid_id === parentId) continue;
      await tx`
        UPDATE app.fact
        SET parent_factoid_id = ${parentId}
        WHERE fact_id = ${f.fact_id}
      `;
    }
  }
});

console.log("");
console.log(`Done.`);
await sql.end();
