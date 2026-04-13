// Farley File quality assessment.
// Run before and after Phase 3 cleanup to measure impact.
//
//   bun run memory/scripts/farley-assess.ts                 # print to stdout
//   bun run memory/scripts/farley-assess.ts --save <label>  # also write JSON snapshot
//
// Snapshots land in notes/farley-assessments/<label>.json so the before/after
// pair can be diffed with `bun run memory/scripts/farley-assess.ts --diff <a> <b>`.

import { mkdir } from "node:fs/promises";
import { sql } from "../db";

const args = process.argv.slice(2);
const saveIdx = args.indexOf("--save");
const saveLabel = saveIdx >= 0 ? args[saveIdx + 1] : null;
const diffIdx = args.indexOf("--diff");
const diffLabels = diffIdx >= 0 ? [args[diffIdx + 1], args[diffIdx + 2]] : null;

const SNAPSHOT_DIR = `${import.meta.dir}/../../notes/farley-assessments`;

// Obvious-junk regexes: a Person factoid matching any of these is almost
// certainly misclassified (login screen, a command, a venue, a playbook).
const JUNK_IN_PERSON_PATTERNS = [
  /login|password|api[\s_-]?key|access[\s_-]?token|credentials?/i,
  /tmux|kitty|vim|emacs|bash|zsh|shell/i,
  /playbook|how[\s_-]?to|setup|configuration|install|cheatsheet/i,
  /center|stadium|arena|theater|theatre|venue|restaurant|bar\b|cafe/i,
];

interface Assessment {
  label: string | null;
  timestamp: string;
  totals: {
    facts_active: number;
    factoids_active: number;
    factoids_human_verified: number;
    relationships: number;
    entity_addresses: number;
  };
  factoid_type_distribution: Record<string, number>;
  person_quality: {
    total: number;
    junk_in_person: number;
    junk_examples: Array<{ fact_id: string; title: string; pattern: string }>;
    short_content_lt_20: number;
    no_address_and_short: number;
    orphan_no_children: number;
  };
  duplication: {
    exact_title_duplicate_groups: number;
    exact_title_duplicate_factoids: number;
    worst_offenders: Array<{ title: string; factoid_type: string; count: number }>;
  };
  fragmentation: {
    possessive_prefix_clusters: number;
    orphaned_fragment_facts: number;
    worst_prefixes: Array<{ prefix: string; fragments: number; parent_exists: boolean }>;
  };
  address_graph: {
    factoids_with_addresses: number;
    addresses_per_factoid_avg: number;
    display_name_collisions: number;
  };
  merges_recorded: number;
}

async function assess(): Promise<Assessment> {
  const [totals] = await sql<
    Array<{
      facts_active: number;
      factoids_active: number;
      factoids_human_verified: number;
      relationships: number;
      entity_addresses: number;
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM app.fact WHERE is_active = true) AS facts_active,
      (SELECT count(*)::int FROM app.fact WHERE is_active = true AND is_factoid = true) AS factoids_active,
      (SELECT count(*)::int FROM app.fact WHERE is_active = true AND is_factoid = true AND human_verified = true) AS factoids_human_verified,
      (SELECT count(*)::int FROM app.fact_relationship) AS relationships,
      (SELECT count(*)::int FROM app.entity_address) AS entity_addresses
  `;

  const typeDistRows = await sql<Array<{ factoid_type: string; n: number }>>`
    SELECT coalesce(factoid_type, '(null)') AS factoid_type, count(*)::int AS n
    FROM app.fact
    WHERE is_active = true AND is_factoid = true
    GROUP BY factoid_type
    ORDER BY n DESC
  `;
  const factoid_type_distribution: Record<string, number> = {};
  for (const row of typeDistRows) factoid_type_distribution[row.factoid_type] = row.n;

  // Person quality.
  const personRows = await sql<Array<{ fact_id: string; title: string; content: string }>>`
    SELECT fact_id, coalesce(title, '') AS title, coalesce(content, '') AS content
    FROM app.fact
    WHERE is_active = true AND is_factoid = true AND factoid_type = 'Person'
  `;
  const junk_examples: Array<{ fact_id: string; title: string; pattern: string }> = [];
  let junk_in_person = 0;
  let short_content_lt_20 = 0;
  let no_address_and_short = 0;
  for (const row of personRows) {
    const haystack = `${row.title} ${row.content}`;
    for (const pat of JUNK_IN_PERSON_PATTERNS) {
      if (pat.test(haystack)) {
        junk_in_person++;
        if (junk_examples.length < 20) {
          junk_examples.push({ fact_id: row.fact_id, title: row.title, pattern: pat.source });
        }
        break;
      }
    }
    if (row.content.length < 20) short_content_lt_20++;
  }

  const [noAddrShort] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM app.fact f
    WHERE f.is_active = true
      AND f.is_factoid = true
      AND f.factoid_type = 'Person'
      AND length(coalesce(f.content, '')) < 20
      AND NOT EXISTS (SELECT 1 FROM app.entity_address ea WHERE ea.factoid_id = f.fact_id)
  `;
  no_address_and_short = noAddrShort.n;

  const [orphanRow] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM app.fact f
    WHERE f.is_active = true
      AND f.is_factoid = true
      AND f.factoid_type = 'Person'
      AND NOT EXISTS (SELECT 1 FROM app.fact c WHERE c.parent_factoid_id = f.fact_id AND c.is_active = true)
  `;

  // Duplication — exact (case-insensitive, trimmed) title match within a type.
  // This is Block A's cheapest version; the real dedupe script uses the full
  // normalization pipeline. Good enough for baseline measurement.
  const dupGroupRows = await sql<
    Array<{ norm: string; factoid_type: string; count: number }>
  >`
    SELECT lower(btrim(coalesce(title, ''))) AS norm,
           factoid_type,
           count(*)::int AS count
    FROM app.fact
    WHERE is_active = true AND is_factoid = true AND title IS NOT NULL
    GROUP BY norm, factoid_type
    HAVING count(*) > 1
    ORDER BY count DESC
  `;
  const exact_title_duplicate_groups = dupGroupRows.length;
  const exact_title_duplicate_factoids = dupGroupRows.reduce(
    (acc, r) => acc + r.count,
    0,
  );
  const worst_offenders = dupGroupRows.slice(0, 15).map((r) => ({
    title: r.norm,
    factoid_type: r.factoid_type,
    count: r.count,
  }));

  // Fragmentation — "X's ..." children without a factoid for X.
  // Use a raw string for the regex so JS escape handling does not mangle
  // \w / \s / \1 before Postgres sees them.
  // Apostrophe is required — otherwise "address is..." and "business plan..."
  // match as `addres` / `busines` possessive artifacts.
  const possessiveRe = String.raw`^(\w+)'s\s`;
  const replaceRe = String.raw`^(\w+)'s\s.*`;
  const prefixRows = await sql<Array<{ prefix: string; fragments: number }>>`
    SELECT regexp_replace(lower(title), ${replaceRe}, ${"\\1"}) AS prefix,
           count(*)::int AS fragments
    FROM app.fact
    WHERE is_active = true
      AND title ~ ${possessiveRe}
      AND (is_factoid = false OR factoid_type IS NULL)
    GROUP BY prefix
    HAVING count(*) >= 3
    ORDER BY count(*) DESC
  `;
  const worst_prefixes: Array<{ prefix: string; fragments: number; parent_exists: boolean }> = [];
  let orphaned_fragment_facts = 0;
  for (const row of prefixRows) {
    const [parent] = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM app.fact
        WHERE is_active = true AND is_factoid = true
          AND lower(title) LIKE ${row.prefix + "%"}
      ) AS exists
    `;
    if (!parent.exists) orphaned_fragment_facts += row.fragments;
    if (worst_prefixes.length < 15) {
      worst_prefixes.push({
        prefix: row.prefix,
        fragments: row.fragments,
        parent_exists: parent.exists,
      });
    }
  }

  // Address graph.
  const [addrStats] = await sql<
    Array<{ factoids_with_addresses: number; addresses_per_factoid_avg: number }>
  >`
    SELECT
      count(DISTINCT factoid_id)::int AS factoids_with_addresses,
      (count(*)::float / NULLIF(count(DISTINCT factoid_id), 0))::float AS addresses_per_factoid_avg
    FROM app.entity_address
  `;
  const [dispCollisions] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM (
      SELECT lower(btrim(display_name)) AS dn, count(DISTINCT factoid_id) AS c
      FROM app.entity_address
      WHERE display_name IS NOT NULL AND display_name <> ''
      GROUP BY dn
      HAVING count(DISTINCT factoid_id) > 1
    ) x
  `;

  let mergesRecorded = 0;
  try {
    const [mergeCount] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM app.fact_merge WHERE dry_run = false
    `;
    mergesRecorded = mergeCount.n;
  } catch {
    // fact_merge table does not exist yet — migration 003 not applied.
  }

  return {
    label: saveLabel,
    timestamp: new Date().toISOString(),
    totals,
    factoid_type_distribution,
    person_quality: {
      total: personRows.length,
      junk_in_person,
      junk_examples,
      short_content_lt_20,
      no_address_and_short,
      orphan_no_children: orphanRow.n,
    },
    duplication: {
      exact_title_duplicate_groups,
      exact_title_duplicate_factoids,
      worst_offenders,
    },
    fragmentation: {
      possessive_prefix_clusters: prefixRows.length,
      orphaned_fragment_facts,
      worst_prefixes,
    },
    address_graph: {
      factoids_with_addresses: addrStats.factoids_with_addresses ?? 0,
      addresses_per_factoid_avg: Number(
        (addrStats.addresses_per_factoid_avg ?? 0).toFixed(2),
      ),
      display_name_collisions: dispCollisions.n,
    },
    merges_recorded: mergesRecorded,
  };
}

function printAssessment(a: Assessment) {
  const pad = (s: string, n = 38) => s.padEnd(n);
  console.log("");
  console.log(`=== Farley File Assessment ${a.label ? `(${a.label})` : ""} ===`);
  console.log(`Timestamp: ${a.timestamp}`);
  console.log("");
  console.log("TOTALS");
  console.log(`  ${pad("Active facts:")}${a.totals.facts_active}`);
  console.log(`  ${pad("Active factoids:")}${a.totals.factoids_active}`);
  console.log(`  ${pad("Human-verified factoids:")}${a.totals.factoids_human_verified}`);
  console.log(`  ${pad("Relationships:")}${a.totals.relationships}`);
  console.log(`  ${pad("Entity addresses:")}${a.totals.entity_addresses}`);
  console.log(`  ${pad("Merges recorded:")}${a.merges_recorded}`);
  console.log("");
  console.log("FACTOID TYPE DISTRIBUTION");
  for (const [type, n] of Object.entries(a.factoid_type_distribution)) {
    console.log(`  ${pad(type + ":")}${n}`);
  }
  console.log("");
  console.log("PERSON QUALITY");
  console.log(`  ${pad("Total Person factoids:")}${a.person_quality.total}`);
  console.log(
    `  ${pad("  matching junk patterns:")}${a.person_quality.junk_in_person} (lower = better)`,
  );
  console.log(
    `  ${pad("  with content <20 chars:")}${a.person_quality.short_content_lt_20}`,
  );
  console.log(
    `  ${pad("  thin AND no address:")}${a.person_quality.no_address_and_short}`,
  );
  console.log(
    `  ${pad("  with zero child facts:")}${a.person_quality.orphan_no_children}`,
  );
  if (a.person_quality.junk_examples.length > 0) {
    console.log("  junk examples (first 10):");
    for (const ex of a.person_quality.junk_examples.slice(0, 10)) {
      console.log(`    - ${ex.title}  [${ex.pattern}]`);
    }
  }
  console.log("");
  console.log("DUPLICATION (exact normalized title within type)");
  console.log(
    `  ${pad("Duplicate groups:")}${a.duplication.exact_title_duplicate_groups}`,
  );
  console.log(
    `  ${pad("Factoids in duplicate groups:")}${a.duplication.exact_title_duplicate_factoids}`,
  );
  if (a.duplication.worst_offenders.length > 0) {
    console.log("  worst offenders:");
    for (const w of a.duplication.worst_offenders) {
      console.log(`    ${w.count}x  [${w.factoid_type}]  ${w.title}`);
    }
  }
  console.log("");
  console.log("FRAGMENTATION (possessive-prefix child clusters)");
  console.log(
    `  ${pad("Prefix clusters (3+ fragments):")}${a.fragmentation.possessive_prefix_clusters}`,
  );
  console.log(
    `  ${pad("Orphaned fragment facts:")}${a.fragmentation.orphaned_fragment_facts}`,
  );
  if (a.fragmentation.worst_prefixes.length > 0) {
    console.log("  worst prefixes:");
    for (const p of a.fragmentation.worst_prefixes) {
      const mark = p.parent_exists ? "✓" : "✗";
      console.log(`    ${p.fragments}x  ${mark} parent  ${p.prefix}`);
    }
  }
  console.log("");
  console.log("ADDRESS GRAPH");
  console.log(
    `  ${pad("Factoids with addresses:")}${a.address_graph.factoids_with_addresses}`,
  );
  console.log(
    `  ${pad("Avg addresses / factoid:")}${a.address_graph.addresses_per_factoid_avg}`,
  );
  console.log(
    `  ${pad("Display-name collisions:")}${a.address_graph.display_name_collisions} (lower = better)`,
  );
  console.log("");
}

function diff(a: Assessment, b: Assessment) {
  console.log("");
  console.log(`=== Diff: ${a.label} → ${b.label} ===`);
  const rows: Array<[string, number, number]> = [
    ["Active factoids", a.totals.factoids_active, b.totals.factoids_active],
    [
      "Human-verified",
      a.totals.factoids_human_verified,
      b.totals.factoids_human_verified,
    ],
    ["Person total", a.person_quality.total, b.person_quality.total],
    [
      "Person junk matches",
      a.person_quality.junk_in_person,
      b.person_quality.junk_in_person,
    ],
    [
      "Person thin+no-addr",
      a.person_quality.no_address_and_short,
      b.person_quality.no_address_and_short,
    ],
    [
      "Duplicate groups",
      a.duplication.exact_title_duplicate_groups,
      b.duplication.exact_title_duplicate_groups,
    ],
    [
      "Factoids in dup groups",
      a.duplication.exact_title_duplicate_factoids,
      b.duplication.exact_title_duplicate_factoids,
    ],
    [
      "Orphaned fragments",
      a.fragmentation.orphaned_fragment_facts,
      b.fragmentation.orphaned_fragment_facts,
    ],
    [
      "Display-name collisions",
      a.address_graph.display_name_collisions,
      b.address_graph.display_name_collisions,
    ],
    ["Merges recorded", a.merges_recorded, b.merges_recorded],
  ];
  const w = 28;
  for (const [name, av, bv] of rows) {
    const delta = bv - av;
    const sign = delta > 0 ? "+" : "";
    console.log(`  ${name.padEnd(w)}${String(av).padStart(6)} → ${String(bv).padStart(6)}  (${sign}${delta})`);
  }
  console.log("");
}

if (diffLabels) {
  const [labelA, labelB] = diffLabels;
  const a = (await Bun.file(`${SNAPSHOT_DIR}/${labelA}.json`).json()) as Assessment;
  const b = (await Bun.file(`${SNAPSHOT_DIR}/${labelB}.json`).json()) as Assessment;
  printAssessment(a);
  printAssessment(b);
  diff(a, b);
} else {
  const a = await assess();
  printAssessment(a);
  if (saveLabel) {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    const path = `${SNAPSHOT_DIR}/${saveLabel}.json`;
    await Bun.write(path, JSON.stringify(a, null, 2));
    console.log(`Snapshot saved to ${path}`);
  }
}

await sql.end();
