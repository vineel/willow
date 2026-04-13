// Hand-curated Farley File seed. Mirrors the profile in
// ~/willow-runtime-workspace/CLAUDE.md. Creates or updates one
// `human_verified=true` factoid per entity so downstream cleanup and
// dedupe have a trusted spine to snap to.
//
//   bun run memory/scripts/seed-farley-from-claude-md.ts              # dry-run
//   bun run memory/scripts/seed-farley-from-claude-md.ts --apply      # write
//
// Idempotent: re-running updates existing rows in place. Existing fragments
// that match a seed by bare-title are adopted as the seed row (keeping
// their fact_id so children stay attached).

import { sql } from "../db";
import { generateEmbedding } from "../lmstudio/client";

const APPLY = process.argv.includes("--apply");

interface Seed {
  title: string;
  factoid_type: "Person" | "Organization" | "Product" | "Place";
  content: string;
  keywords: string[];
  // Alternative titles to match against existing factoids for adoption.
  aliases?: string[];
}

const SEEDS: Seed[] = [
  // ---- Vineel + immediate family
  {
    title: "Vineel Shah",
    factoid_type: "Person",
    content:
      "Vineel Vinod Shah — owner of this Willow system. Born September 27, 1971 (age 54). Lives at 25 Wesley Court, South Orange, NJ. Email vineel@vineel.com. Phone 646-246-8258. BA Computer Science, NYU. Indian-American, politically liberal. ~30 years software engineering (AWS Wickr / Chime SDK, Walmart Global Tech Sr Manager II, Salido CTO, RedRover CTO, Yahoo HotJobs, Sesame Street Online, MTV Online). Currently CTO and technical co-founder at Accordli with Brad Simon. Not drawing salary — funding life from stock portfolio. Two herniated discs since August 2025. Heavy family logistics — kids and aging parents.",
    keywords: ["vineel", "vineel shah", "vineel vinod shah", "owner", "cto"],
    aliases: ["Vineel", "vineel", "Vineel Vinod Shah"],
  },
  {
    title: "Stephanie Sokaris",
    factoid_type: "Person",
    content:
      "Vineel's wife. Runs a side business making leather accessories at home. Maiden name Sokaris — family from Albany, NY.",
    keywords: ["stephanie", "stephanie sokaris", "wife"],
    aliases: ["Stephanie", "Steph"],
  },
  {
    title: "Zeph Shah",
    factoid_type: "Person",
    content:
      "Zephyros 'Zeph' Shah. Vineel and Stephanie's son. Born June 2, 2010 (age 15). Very shy, slightly autistic (high-functioning). Finds school useless and boring. Needs help with social interaction and motivation.",
    keywords: ["zeph", "zephyros", "zeph shah", "son"],
    aliases: ["Zephyros Shah", "Zephyros", "Zeph"],
  },
  {
    title: "Ele Shah",
    factoid_type: "Person",
    content:
      "Elektra 'Ele' Shah. Vineel and Stephanie's child. Born September 5, 2012 (age 13). Uses they/them pronouns. Preferred name is Ele (pronounced 'Ellie'). Has OCD and ADHD, currently in therapy.",
    keywords: ["ele", "elektra", "ele shah", "daughter", "child"],
    aliases: ["Elektra Shah", "Elektra", "Ele"],
  },

  // ---- Shah extended
  {
    title: "Vinod Shah",
    factoid_type: "Person",
    content:
      "Vineel's father. Age 87. Lives in West Orange, NJ (~10 min from Vineel). Can't drive. Vineel manages his medical appointments.",
    keywords: ["vinod", "vinod shah", "father", "dad"],
  },
  {
    title: "Neela Shah",
    factoid_type: "Person",
    content:
      "Vineel's mother. Age 85. Lives in West Orange, NJ (~10 min from Vineel). Can't drive. Has ongoing health concerns — ulcer, medication schedule, stress tests. NOT a pet.",
    keywords: ["neela", "neela shah", "mother", "mom"],
    aliases: ["Neela"],
  },
  {
    title: "Nigam Shah",
    factoid_type: "Person",
    content: "Vineel's brother. Lives in Springfield, NJ (~15 min).",
    keywords: ["nigam", "nigam shah", "brother"],
  },
  {
    title: "Heidi Matthews",
    factoid_type: "Person",
    content: "Vineel's sister-in-law. Married to Nigam Shah. Springfield, NJ.",
    keywords: ["heidi", "heidi matthews", "sister-in-law"],
  },
  {
    title: "Arjun Shah",
    factoid_type: "Person",
    content: "Vineel's nephew. Son of Nigam and Heidi. Age 13. Springfield, NJ.",
    keywords: ["arjun", "arjun shah", "nephew"],
  },
  {
    title: "Priya Shah",
    factoid_type: "Person",
    content: "Vineel's niece. Daughter of Nigam and Heidi. Age 8. Springfield, NJ.",
    keywords: ["priya", "priya shah", "niece"],
  },

  // ---- Sokaris extended (Albany, NY)
  {
    title: "Mary Sokaris",
    factoid_type: "Person",
    content: "Vineel's mother-in-law. Stephanie's mother. Lives in Albany, NY.",
    keywords: ["mary", "mary sokaris", "mother-in-law"],
  },
  {
    title: "Stratton Sokaris",
    factoid_type: "Person",
    content: "Vineel's brother-in-law. Stephanie's brother. Albany, NY.",
    keywords: ["stratton", "stratton sokaris", "brother-in-law"],
  },
  {
    title: "Roxanne Sokaris",
    factoid_type: "Person",
    content: "Vineel's sister-in-law. Stratton's wife. Albany, NY.",
    keywords: ["roxanne", "roxanne sokaris", "sister-in-law"],
  },
  {
    title: "Ryleigh Sokaris",
    factoid_type: "Person",
    content: "Vineel's niece. Daughter of Stratton and Roxanne. Age 16. Albany, NY.",
    keywords: ["ryleigh", "ryleigh sokaris", "niece"],
  },
  {
    title: "Zoe Sokaris",
    factoid_type: "Person",
    content: "Vineel's niece. Daughter of Stratton and Roxanne. Age 14. Albany, NY.",
    keywords: ["zoe", "zoe sokaris", "niece"],
  },
  {
    title: "James Sokaris",
    factoid_type: "Person",
    content: "Vineel's nephew. Son of Stratton and Roxanne. Age 8. Albany, NY.",
    keywords: ["james", "james sokaris", "nephew"],
  },
  {
    title: "Sandra Sokaris",
    factoid_type: "Person",
    content: "Vineel's niece. Daughter of Stratton and Roxanne. Age ~5. Albany, NY.",
    keywords: ["sandra", "sandra sokaris", "niece"],
  },

  // ---- Work
  {
    title: "Brad Simon",
    factoid_type: "Person",
    content:
      "Vineel's technical co-founder partner at Accordli. Lawyer by background. Friend from high school. Driving the product vision for the AI Contracting Workbench for Lawyers.",
    keywords: ["brad", "brad simon", "accordli", "cofounder", "partner"],
    aliases: ["Brad"],
  },
  {
    title: "Accordli",
    factoid_type: "Organization",
    content:
      "AI Contracting Workbench for Lawyers. Vineel's current primary focus (April 2026). Vineel is Technical Co-founder / CTO building the MVP. Co-founder Brad Simon (lawyer). Bootstrapped, working toward MVP, hoping to raise funding soon.",
    keywords: ["accordli", "cto", "startup", "contracts", "legal"],
  },
  {
    title: "Willow",
    factoid_type: "Product",
    content:
      "This system. Vineel's personal AI agent running on a Mac Mini. Second brain (memory graph of people, facts, events) + Personal Information Bus (email ingestion / triage / classification / action) + Agent Runner (scheduled agent scripts). Key motivation: help manage family schedule and aging parents' medical appointments.",
    keywords: ["willow", "agent", "memory", "second brain", "pib"],
  },
];

// ============================================================================
// Match existing rows by bare title, adopt if found, otherwise insert.
// ============================================================================

function bareTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface ExistingRow {
  fact_id: string;
  title: string | null;
  factoid_type: string | null;
  is_factoid: boolean;
  is_active: boolean;
  human_verified: boolean;
}

const existing = await sql<ExistingRow[]>`
  SELECT fact_id, title, factoid_type, is_factoid, is_active, human_verified
  FROM app.fact
  WHERE is_active = true AND is_factoid = true
`;
const byBareTitle = new Map<string, ExistingRow>();
for (const r of existing) {
  const bt = bareTitle(r.title ?? "");
  if (!bt) continue;
  // Prefer human-verified, then rows with a type.
  const prior = byBareTitle.get(bt);
  if (!prior) {
    byBareTitle.set(bt, r);
    continue;
  }
  if (!prior.human_verified && r.human_verified) byBareTitle.set(bt, r);
  else if (!prior.factoid_type && r.factoid_type) byBareTitle.set(bt, r);
}

interface Plan {
  seed: Seed;
  action: "insert" | "update";
  existing: ExistingRow | null;
}

const plans: Plan[] = [];
for (const seed of SEEDS) {
  const candidates = [seed.title, ...(seed.aliases ?? [])].map(bareTitle);
  let found: ExistingRow | null = null;
  for (const c of candidates) {
    const r = byBareTitle.get(c);
    if (r) {
      found = r;
      break;
    }
  }
  plans.push({
    seed,
    action: found ? "update" : "insert",
    existing: found,
  });
}

console.log("");
console.log(`=== Farley seed (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
for (const p of plans) {
  const mark = p.action === "update" ? "UPDATE" : "INSERT";
  const was = p.existing
    ? `(was: "${p.existing.title}" [${p.existing.factoid_type ?? "null"}])`
    : "";
  console.log(`  ${mark}  ${p.seed.title} [${p.seed.factoid_type}]  ${was}`);
}
console.log("");
const inserts = plans.filter((p) => p.action === "insert").length;
const updates = plans.filter((p) => p.action === "update").length;
console.log(`Plan: ${inserts} insert, ${updates} update`);
console.log("");

if (!APPLY) {
  console.log("Dry-run only. Re-run with --apply to write.");
  await sql.end();
  process.exit(0);
}

// Embed each seed's content via LM Studio and upsert.
for (const p of plans) {
  const text = `${p.seed.title}\n${p.seed.content}`;
  const { embedding } = await generateEmbedding(text);
  const vecLit = `[${embedding.join(",")}]`;

  if (p.action === "update" && p.existing) {
    await sql`
      UPDATE app.fact
      SET title = ${p.seed.title},
          content = ${p.seed.content},
          keywords = ${p.seed.keywords},
          factoid_type = ${p.seed.factoid_type},
          human_verified = true,
          is_factoid = true,
          memory_type = 'long_term',
          status = 'clustered',
          embedding = ${vecLit}::vector,
          updated_at = now()
      WHERE fact_id = ${p.existing.fact_id}
    `;
    console.log(`UPDATED ${p.seed.title} (${p.existing.fact_id})`);
  } else {
    const [created] = await sql<Array<{ fact_id: string }>>`
      INSERT INTO app.fact
        (title, content, keywords, is_factoid, factoid_type, human_verified,
         memory_type, status, embedding)
      VALUES (
        ${p.seed.title},
        ${p.seed.content},
        ${p.seed.keywords},
        true,
        ${p.seed.factoid_type},
        true,
        'long_term',
        'clustered',
        ${vecLit}::vector
      )
      RETURNING fact_id
    `;
    console.log(`INSERTED ${p.seed.title} (${created.fact_id})`);
  }
}

console.log("");
console.log("Done.");
await sql.end();
