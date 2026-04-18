#!/usr/bin/env bun
// Snapshot the memory graph as a self-contained HTML outline.
// Output: ~/willow-runtime-workspace/brain-map/brain-map-YYYY-MM-DD-HHMMSS.html

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "../memory/db";

type Fact = {
  fact_id: string;
  title: string | null;
  content: string;
  is_factoid: boolean;
  factoid_type: string | null;
  parent_factoid_id: string | null;
};

type Rel = {
  from_factoid_id: string;
  to_factoid_id: string;
  type: string;
  inverse_type: string | null;
  description: string | null;
};

const includeInactive = process.argv.includes("--include-inactive");

const activeClause = includeInactive ? sql`` : sql`AND is_active = true`;

const facts: Fact[] = await sql`
  SELECT fact_id, title, content, is_factoid, factoid_type, parent_factoid_id
  FROM app.fact
  WHERE TRUE ${activeClause}
  ORDER BY is_factoid DESC, factoid_type NULLS LAST, title NULLS LAST
`;

const rels: Rel[] = await sql`
  SELECT fr.from_factoid_id, fr.to_factoid_id, fr.type, fr.inverse_type, fr.description
  FROM app.fact_relationship fr
  JOIN app.fact f1 ON f1.fact_id = fr.from_factoid_id
  JOIN app.fact f2 ON f2.fact_id = fr.to_factoid_id
  WHERE TRUE
  ${includeInactive ? sql`` : sql`AND f1.is_active = true AND f2.is_active = true`}
`;

await sql.end();

const byId = new Map<string, Fact>();
const childrenOf = new Map<string, Fact[]>();
for (const f of facts) {
  byId.set(f.fact_id, f);
  if (f.parent_factoid_id) {
    const arr = childrenOf.get(f.parent_factoid_id) ?? [];
    arr.push(f);
    childrenOf.set(f.parent_factoid_id, arr);
  }
}

const relsByFrom = new Map<string, Rel[]>();
for (const r of rels) {
  const arr = relsByFrom.get(r.from_factoid_id) ?? [];
  arr.push(r);
  relsByFrom.set(r.from_factoid_id, arr);
}

const people = facts
  .filter((f) => f.is_factoid && f.factoid_type === "Person")
  .sort((a, b) => (a.title ?? a.content).localeCompare(b.title ?? b.content));

const personIds = new Set(people.map((p) => p.fact_id));

// Non-person root factoids that have at least one descendant
const rootFactoids = facts
  .filter(
    (f) =>
      f.is_factoid &&
      !f.parent_factoid_id &&
      f.factoid_type !== "Person" &&
      (childrenOf.get(f.fact_id)?.length ?? 0) > 0,
  )
  .sort((a, b) =>
    (a.factoid_type ?? "").localeCompare(b.factoid_type ?? "") ||
    (a.title ?? a.content).localeCompare(b.title ?? b.content),
  );

// Orphans: facts with no parent, no children, not a person, not already in rootFactoids
const usedRoots = new Set(rootFactoids.map((f) => f.fact_id));
const orphans = facts
  .filter(
    (f) =>
      !personIds.has(f.fact_id) &&
      !usedRoots.has(f.fact_id) &&
      !f.parent_factoid_id &&
      (childrenOf.get(f.fact_id)?.length ?? 0) === 0,
  )
  .sort((a, b) =>
    (a.factoid_type ?? "zzz").localeCompare(b.factoid_type ?? "zzz") ||
    (a.title ?? a.content).localeCompare(b.title ?? b.content),
  );

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function anchorId(id: string): string {
  return `f-${id}`;
}

function renderNode(f: Fact, depth = 0): string {
  const kids = childrenOf.get(f.fact_id) ?? [];
  const label = esc(f.title || f.content.slice(0, 120));
  const typeBadge = f.factoid_type
    ? `<span class="type">${esc(f.factoid_type)}</span>`
    : "";
  const body = f.title && f.content !== f.title
    ? `<div class="content">${esc(f.content)}</div>`
    : "";
  const relList = relsByFrom.get(f.fact_id) ?? [];
  const relsHtml = relList.length
    ? `<ul class="rels">${relList
        .map((r) => {
          const target = byId.get(r.to_factoid_id);
          const targetLabel = target
            ? esc(target.title || target.content.slice(0, 80))
            : r.to_factoid_id;
          const link = target
            ? `<a href="#${anchorId(target.fact_id)}">${targetLabel}</a>`
            : targetLabel;
          return `<li><span class="reltype">${esc(r.type)}</span> → ${link}${
            r.description ? ` <em>(${esc(r.description)})</em>` : ""
          }</li>`;
        })
        .join("")}</ul>`
    : "";

  if (kids.length === 0 && !relsHtml && !body) {
    return `<li id="${anchorId(f.fact_id)}" class="leaf">${label} ${typeBadge}</li>`;
  }

  const childrenHtml = kids.length
    ? `<ul>${kids
        .slice()
        .sort((a, b) =>
          (a.title ?? a.content).localeCompare(b.title ?? b.content),
        )
        .map((c) => renderNode(c, depth + 1))
        .join("")}</ul>`
    : "";

  const open = depth === 0 ? " open" : "";
  return `<li id="${anchorId(f.fact_id)}"><details${open}><summary>${label} ${typeBadge}</summary>${body}${relsHtml}${childrenHtml}</details></li>`;
}

const peopleHtml = people.map((p) => renderNode(p)).join("");
const rootsHtml = rootFactoids.map((r) => renderNode(r)).join("");
const orphansHtml = orphans
  .map((o) => {
    const label = esc(o.title || o.content.slice(0, 200));
    const typeBadge = o.factoid_type
      ? `<span class="type">${esc(o.factoid_type)}</span>`
      : "";
    return `<li id="${anchorId(o.fact_id)}" class="leaf">${label} ${typeBadge}</li>`;
  })
  .join("");

const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

const totalFacts = facts.length;
const totalFactoids = facts.filter((f) => f.is_factoid).length;
const totalRels = rels.length;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Willow brain-map ${stamp}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
  .meta { color: #666; margin-bottom: 1.5rem; font-size: 0.85rem; }
  h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; margin-top: 2rem; }
  ul { list-style: none; padding-left: 1.2rem; }
  li { margin: 0.15rem 0; }
  li.leaf { padding-left: 1rem; }
  details > summary { cursor: pointer; }
  details > summary:hover { background: #f5f5f5; }
  .type { display: inline-block; font-size: 0.7rem; background: #eef; color: #336; padding: 0 0.4rem; border-radius: 3px; margin-left: 0.3rem; }
  .content { color: #444; margin: 0.3rem 0 0.3rem 1.2rem; font-size: 0.9rem; }
  .rels { margin: 0.3rem 0 0.3rem 1.2rem; font-size: 0.85rem; color: #555; }
  .reltype { color: #963; font-weight: 500; }
  .controls { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  #filter { flex: 1; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
  .controls button { padding: 0 1rem; font-size: 0.9rem; cursor: pointer; background: #f5f5f5; border: 1px solid #ccc; border-radius: 4px; }
  .controls button:hover { background: #eee; }
  a { color: #06c; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<h1>Willow brain-map</h1>
<div class="meta">Snapshot ${stamp} · ${totalFacts} facts · ${totalFactoids} factoids · ${totalRels} relationships${includeInactive ? " · including inactive" : ""}</div>
<div class="controls">
  <input id="filter" type="search" placeholder="Filter (case-insensitive substring)…">
  <button id="expand-all" type="button">Expand all</button>
  <button id="collapse-all" type="button">Collapse all</button>
</div>

<h2>People (${people.length})</h2>
<ul>${peopleHtml}</ul>

<h2>Root factoids (${rootFactoids.length})</h2>
<ul>${rootsHtml}</ul>

<h2>Orphans (${orphans.length})</h2>
<ul>${orphansHtml}</ul>

<script>
document.getElementById('expand-all').addEventListener('click', () => {
  document.querySelectorAll('details').forEach(d => d.open = true);
});
document.getElementById('collapse-all').addEventListener('click', () => {
  document.querySelectorAll('details').forEach(d => d.open = false);
});
const filter = document.getElementById('filter');
filter.addEventListener('input', () => {
  const q = filter.value.trim().toLowerCase();
  const items = document.querySelectorAll('li');
  if (!q) {
    items.forEach(li => li.classList.remove('hidden'));
    return;
  }
  items.forEach(li => {
    const text = li.textContent.toLowerCase();
    li.classList.toggle('hidden', !text.includes(q));
  });
  // Re-show ancestors of any visible match
  document.querySelectorAll('li:not(.hidden)').forEach(li => {
    let p = li.parentElement;
    while (p) {
      if (p.tagName === 'LI') p.classList.remove('hidden');
      if (p.tagName === 'DETAILS') p.open = true;
      p = p.parentElement;
    }
  });
});
</script>
</body>
</html>
`;

const outDir = join(homedir(), "willow-runtime-workspace", "brain-map");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `brain-map-${stamp}.html`);
await Bun.write(outPath, html);
console.log(`wrote ${outPath}`);
console.log(`  ${people.length} people · ${rootFactoids.length} root factoids · ${orphans.length} orphans`);
