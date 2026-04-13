// Factoid type reclassification sweep — failure mode 1 from
// notes/person-dedupe-strategy.md.
//
// Rule-based title-primary matcher. Walks every active factoid (and every
// is_factoid=true row with a NULL type) and applies an ordered rule list:
// first match wins. Rules intentionally err on the side of false negatives —
// ambiguous cases are left for the LLM maintenance pass.
//
//   bun run memory/scripts/cleanup-factoid-types.ts              # dry-run
//   bun run memory/scripts/cleanup-factoid-types.ts --apply      # write
//
// Dry-run prints proposed changes grouped by rule with sample titles.
// Apply wraps the whole sweep in a single transaction.

import { sql } from "../db";

const APPLY = process.argv.includes("--apply");

type Action =
  | { kind: "reclassify"; to: string }
  | { kind: "demote" }; // set is_factoid=false, clear factoid_type

interface Rule {
  name: string;
  action: Action;
  test: (title: string, content: string) => boolean;
}

// Rules are evaluated in order; first match wins. Title is the primary
// signal. Content is only used as a disqualifier in a few rules to avoid
// grabbing false positives (e.g. a legitimate person named "Kitty").

const RULES: Rule[] = [
  {
    name: "Account — trailing account/login/credentials/etc",
    action: { kind: "reclassify", to: "Account" },
    test: (title) =>
      /\b(account|login|credentials?|password|api\s*key|access\s*token|sign[\s-]*in|subscription)\b\s*$/i.test(
        title,
      ),
  },
  {
    name: "Account — leading sign-in/login phrasing",
    action: { kind: "reclassify", to: "Account" },
    test: (title) =>
      /^(log[\s-]*in to|sign[\s-]*in to|access to|credentials for)\b/i.test(title),
  },
  {
    name: "Playbook/command — command-tool prefix",
    action: { kind: "demote" },
    test: (title) =>
      /^(tmux|kitty|vim|emacs|neovim|bash|zsh|git|docker|kubectl|psql|ssh)\b/i.test(
        title,
      ),
  },
  {
    name: "Playbook/command — how-to/setup/cheatsheet phrasing",
    action: { kind: "demote" },
    test: (title) =>
      /\b(playbook|cheatsheet|cheat\s*sheet|how[\s-]*to|tutorial|setup|installation|configuration|troubleshooting)\b/i.test(
        title,
      ),
  },
  {
    name: "Place — trailing venue noun",
    action: { kind: "reclassify", to: "Place" },
    test: (title) =>
      /\b(center|centre|stadium|arena|theat(er|re)|hall|park|plaza|mall|airport|station)\s*$/i.test(
        title,
      ),
  },
];

interface FactRow {
  fact_id: string;
  title: string | null;
  content: string;
  factoid_type: string | null;
  is_factoid: boolean;
}

const rows = await sql<FactRow[]>`
  SELECT fact_id, title, content, factoid_type, is_factoid
  FROM app.fact
  WHERE is_active = true
    AND (
      is_factoid = true
      OR (is_factoid = true AND factoid_type IS NULL)
    )
`;

interface Proposal {
  rule: Rule;
  row: FactRow;
  fromType: string | null;
}

const proposalsByRule = new Map<string, Proposal[]>();
for (const rule of RULES) proposalsByRule.set(rule.name, []);

for (const row of rows) {
  const title = row.title ?? "";
  if (!title) continue;
  for (const rule of RULES) {
    if (!rule.test(title, row.content)) continue;

    // Skip no-ops: reclassify to the same type, or demote something already
    // demoted.
    if (rule.action.kind === "reclassify" && row.factoid_type === rule.action.to) {
      break;
    }
    if (rule.action.kind === "demote" && row.is_factoid === false) {
      break;
    }

    proposalsByRule.get(rule.name)!.push({ rule, row, fromType: row.factoid_type });
    break;
  }
}

console.log("");
console.log(`=== Factoid type cleanup (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
console.log(`Scanned ${rows.length} active factoid rows`);
console.log("");

let total = 0;
for (const rule of RULES) {
  const props = proposalsByRule.get(rule.name)!;
  total += props.length;
  const arrow =
    rule.action.kind === "reclassify"
      ? `→ ${rule.action.to}`
      : "→ is_factoid=false";
  console.log(`[${props.length}] ${rule.name}  ${arrow}`);
  for (const p of props.slice(0, 8)) {
    const from = p.fromType ?? "(null)";
    console.log(`    ${from.padEnd(14)} | ${p.row.title}`);
  }
  if (props.length > 8) console.log(`    ... +${props.length - 8} more`);
  console.log("");
}
console.log(`Total proposed changes: ${total}`);
console.log("");

if (!APPLY) {
  console.log("Dry-run only. Re-run with --apply to write.");
  await sql.end();
  process.exit(0);
}

if (total === 0) {
  console.log("Nothing to do.");
  await sql.end();
  process.exit(0);
}

// Apply — one transaction, grouped updates per rule.
await sql.begin(async (tx) => {
  for (const rule of RULES) {
    const props = proposalsByRule.get(rule.name)!;
    if (props.length === 0) continue;
    const ids = props.map((p) => p.row.fact_id);

    if (rule.action.kind === "reclassify") {
      const to = rule.action.to;
      await tx`
        UPDATE app.fact
        SET factoid_type = ${to}
        WHERE fact_id = ANY(${ids}::uuid[])
      `;
    } else {
      await tx`
        UPDATE app.fact
        SET is_factoid = false, factoid_type = NULL
        WHERE fact_id = ANY(${ids}::uuid[])
      `;
    }
    console.log(`APPLIED ${props.length}: ${rule.name}`);
  }
});

console.log("");
console.log(`Done. ${total} rows updated.`);
await sql.end();
