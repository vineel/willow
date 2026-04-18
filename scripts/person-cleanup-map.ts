#!/usr/bin/env bun
// Render a Person-cleanup HTML form: every active Person factoid with a
// NotPerson checkbox, correct-type dropdown, editable name, read-only list
// of existing child facts, and an "add facts" input (pipe-separated). A
// "Create Submit Prompt" button collects all edits and copies a prompt to
// the clipboard for pasting into Claude Code.
//
// Output: ~/willow-runtime-workspace/brain-map/person-cleanup-YYYY-MM-DD-HHMMSS.html

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "../memory/db";

interface Person {
  fact_id: string;
  title: string;
  content: string;
}

interface ChildFact {
  fact_id: string;
  parent_factoid_id: string;
  title: string | null;
  content: string;
}

const people: Person[] = await sql`
  SELECT fact_id, title, content
  FROM app.fact
  WHERE is_active = true
    AND is_factoid = true
    AND factoid_type = 'Person'
    AND title IS NOT NULL
  ORDER BY lower(btrim(title)) ASC
`;

const children: ChildFact[] = await sql`
  SELECT fact_id, parent_factoid_id, title, content
  FROM app.fact
  WHERE is_active = true
    AND is_factoid = false
    AND parent_factoid_id IN ${sql(people.map((p) => p.fact_id))}
  ORDER BY parent_factoid_id, created_at
`;

await sql.end();

const childrenByParent = new Map<string, ChildFact[]>();
for (const c of children) {
  const arr = childrenByParent.get(c.parent_factoid_id) ?? [];
  arr.push(c);
  childrenByParent.set(c.parent_factoid_id, arr);
}

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TYPES = ["Organization", "Place", "Event", "Concept", "Product", "Account", "Unknown", "MARKETING", "DELETE"];

const rows = people
  .map((p, i) => {
    const kids = childrenByParent.get(p.fact_id) ?? [];
    const kidsHtml = kids.length
      ? `<ul class="kids">${kids
          .map((k) => `<li>${esc(k.title || k.content.slice(0, 120))}</li>`)
          .join("")}</ul>`
      : `<span class="kids-empty">— no child facts —</span>`;

    const typeOptions = TYPES.map((t) => {
      if (t === "DELETE") return `<option value="DELETE">🗑 delete fact</option>`;
      if (t === "MARKETING") return `<option value="MARKETING">📢 marketing noise (block sender)</option>`;
      return `<option value="${t}">${t}</option>`;
    }).join("");

    return `<tr data-fact-id="${p.fact_id}" data-original-title="${esc(p.title)}">
      <td class="idx">${i + 1}</td>
      <td class="np"><input type="checkbox" class="not-person" title="Mark as not a person"></td>
      <td><select class="correct-type" disabled><option value="">—</option>${typeOptions}</select></td>
      <td><input type="text" class="name" value="${esc(p.title)}"></td>
      <td class="existing">${kidsHtml}</td>
      <td><input type="text" class="add-facts" placeholder="fact 1 | fact 2 | fact 3"></td>
      <td class="fid"><code title="${p.fact_id}">${p.fact_id.slice(0, 8)}</code></td>
    </tr>`;
  })
  .join("");

const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Willow person-cleanup ${stamp}</title>
<style>
  body { font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 1.5rem; color: #222; }
  h1 { font-size: 1.3rem; margin: 0 0 0.3rem 0; }
  .meta { color: #666; margin-bottom: 1rem; font-size: 0.85rem; }
  .controls { position: sticky; top: 0; background: white; padding: 0.6rem 0; border-bottom: 1px solid #ddd; margin-bottom: 0.5rem; z-index: 10; display: flex; gap: 0.6rem; align-items: center; }
  #filter { flex: 1; padding: 0.4rem; font-size: 0.9rem; }
  button { padding: 0.45rem 0.9rem; font-size: 0.9rem; cursor: pointer; background: #0066cc; color: white; border: 0; border-radius: 4px; }
  button:hover { background: #0052a3; }
  button.secondary { background: #f5f5f5; color: #333; border: 1px solid #ccc; }
  button.secondary:hover { background: #eee; }
  #change-count { color: #666; font-size: 0.85rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #eee; vertical-align: top; text-align: left; }
  th { background: #fafafa; position: sticky; top: 52px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; color: #555; }
  tr.dirty { background: #fff8e1; }
  tr.to-delete { background: #ffe5e5; }
  tr.to-delete input.name { text-decoration: line-through; color: #a00; }
  tr.to-marketing { background: #e8f0ff; }
  tr.to-marketing input.name { color: #036; }
  tr.hidden { display: none; }
  td.idx { color: #999; width: 2.5rem; text-align: right; }
  td.np { width: 1.5rem; text-align: center; }
  td.fid code { color: #888; font-size: 0.8rem; cursor: copy; }
  input.name { width: 100%; min-width: 10rem; padding: 0.3rem; font-size: 0.9rem; border: 1px solid #ddd; border-radius: 3px; }
  input.name.edited { border-color: #f90; background: #fffbe6; }
  input.add-facts { width: 100%; min-width: 18rem; padding: 0.3rem; font-size: 0.9rem; border: 1px solid #ddd; border-radius: 3px; }
  select.correct-type { padding: 0.25rem; font-size: 0.85rem; }
  td.existing { max-width: 28rem; color: #777; font-size: 0.82rem; }
  ul.kids { margin: 0; padding-left: 1rem; }
  ul.kids li { margin: 0.05rem 0; }
  .kids-empty { color: #bbb; font-style: italic; }
  #toast { position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%); background: #222; color: white; padding: 0.8rem 1.4rem; border-radius: 4px; font-size: 0.9rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  #toast.show { opacity: 1; }
</style>
</head>
<body>
<h1>Willow Person Cleanup</h1>
<div class="meta">Snapshot ${stamp} · ${people.length} active Person factoids</div>

<div class="controls">
  <button id="create-prompt">Create Submit Prompt</button>
  <button class="secondary" id="clear-all">Clear all edits</button>
  <input id="filter" type="search" placeholder="Filter by name, fact text, or fact_id…">
  <span id="change-count">0 changes</span>
</div>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Not Person</th>
      <th>Correct Type</th>
      <th>Name</th>
      <th>Existing facts</th>
      <th>Add facts (pipe-separated)</th>
      <th>ID</th>
    </tr>
  </thead>
  <tbody id="rows">${rows}</tbody>
</table>

<div id="toast"></div>

<script>
const rowsEl = document.getElementById('rows');
const changeCountEl = document.getElementById('change-count');
const toastEl = document.getElementById('toast');

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function rowChanges(tr) {
  const np = tr.querySelector('.not-person').checked;
  const correctType = tr.querySelector('.correct-type').value;
  const nameInput = tr.querySelector('.name');
  const originalTitle = tr.dataset.originalTitle;
  const currentName = nameInput.value.trim();
  const renamed = currentName !== originalTitle && currentName.length > 0;
  const addFacts = tr.querySelector('.add-facts').value
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const changed = np || renamed || addFacts.length > 0;
  return {
    changed,
    factId: tr.dataset.factId,
    originalTitle,
    currentName,
    renamed,
    notPerson: np,
    correctType: np ? correctType : '',
    addFacts,
  };
}

function updateRowDirtyState(tr) {
  const c = rowChanges(tr);
  tr.classList.toggle('dirty', c.changed);
  tr.classList.toggle('to-delete', c.notPerson && c.correctType === 'DELETE');
  tr.classList.toggle('to-marketing', c.notPerson && c.correctType === 'MARKETING');
  const nameInput = tr.querySelector('.name');
  nameInput.classList.toggle('edited', c.renamed);
  return c.changed;
}

function updateChangeCount() {
  let n = 0;
  rowsEl.querySelectorAll('tr').forEach(tr => {
    if (updateRowDirtyState(tr)) n++;
  });
  changeCountEl.textContent = n + (n === 1 ? ' change' : ' changes');
}

// Enable type dropdown only when NotPerson is checked
rowsEl.addEventListener('change', (e) => {
  const target = e.target;
  const tr = target.closest('tr');
  if (!tr) return;
  if (target.classList.contains('not-person')) {
    const select = tr.querySelector('.correct-type');
    select.disabled = !target.checked;
    if (!target.checked) select.value = '';
  }
  updateChangeCount();
});
rowsEl.addEventListener('input', () => updateChangeCount());

// Click fact_id to copy
rowsEl.addEventListener('click', (e) => {
  const code = e.target.closest('code');
  if (!code) return;
  const full = code.getAttribute('title');
  navigator.clipboard.writeText(full).then(() => showToast('fact_id copied: ' + full.slice(0, 8) + '…'));
});

// Filter
document.getElementById('filter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  rowsEl.querySelectorAll('tr').forEach(tr => {
    if (!q) { tr.classList.remove('hidden'); return; }
    const text = tr.textContent.toLowerCase();
    tr.classList.toggle('hidden', !text.includes(q));
  });
});

// Clear all edits
document.getElementById('clear-all').addEventListener('click', () => {
  if (!confirm('Clear all edits on this page?')) return;
  rowsEl.querySelectorAll('tr').forEach(tr => {
    tr.querySelector('.not-person').checked = false;
    const select = tr.querySelector('.correct-type');
    select.value = '';
    select.disabled = true;
    const nameInput = tr.querySelector('.name');
    nameInput.value = tr.dataset.originalTitle;
    tr.querySelector('.add-facts').value = '';
  });
  updateChangeCount();
});

// Create submit prompt
document.getElementById('create-prompt').addEventListener('click', () => {
  const changes = [];
  rowsEl.querySelectorAll('tr').forEach(tr => {
    const c = rowChanges(tr);
    if (c.changed) changes.push(c);
  });
  if (changes.length === 0) {
    showToast('No changes to submit');
    return;
  }

  const deletions = changes.filter(c => c.notPerson && c.correctType === 'DELETE');
  const marketing = changes.filter(c => c.notPerson && c.correctType === 'MARKETING');
  const demotions = changes.filter(c => c.notPerson && c.correctType !== 'DELETE' && c.correctType !== 'MARKETING');
  const renames = changes.filter(c => c.renamed && !c.notPerson);
  const newFacts = changes.filter(c =>
    c.addFacts.length > 0 &&
    !(c.notPerson && (c.correctType === 'DELETE' || c.correctType === 'MARKETING'))
  );

  const lines = [];
  lines.push('Apply the following person-cleanup changes to the Willow memory database using SQL on the \`app.fact\` table (and \`willow-memory\` MCP tools if helpful):');
  lines.push('');

  if (deletions.length > 0) {
    lines.push('## Deletions (soft-delete: set is_active = false)');
    lines.push('');
    lines.push('Set \`is_active = false\` on each of these factoids. Leave child facts and relationships alone — they will become orphans, which is fine.');
    lines.push('');
    for (const c of deletions) {
      lines.push('- \`' + c.factId + '\` "' + c.originalTitle + '"');
    }
    lines.push('');
  }

  if (marketing.length > 0) {
    lines.push('## Marketing noise (block sender, then soft-delete)');
    lines.push('');
    lines.push('These are real people (usually politicians, influencers, newsletter authors) who slipped in via marketing / fundraising / blast email. Factually they ARE persons, but Vineel does not want to track them. For each one, do all three steps in a single transaction:');
    lines.push('');
    lines.push('1. Keep \`factoid_type = \\'Person\\'\` (or set it back to Person if it was changed) — the type system describes what something IS, not whether we care.');
    lines.push('2. Soft-delete: \`UPDATE app.fact SET is_active = false WHERE fact_id = X\`.');
    lines.push('3. Look up the sender address(es) via \`SELECT source_type, address, display_name FROM app.entity_address WHERE factoid_id = X\`. For each email address found, insert a priority-1 block rule into \`app.triage_rule\`:');
    lines.push('   - Always: \`field=\\'from_address\\' operator=\\'equals\\' value=<address> action=\\'noise\\' source=\\'user\\' priority=1 enabled=true confirmed=true\`.');
    lines.push('   - Also check the address domain: if it\\'s a marketing-relay domain (ccsend.com, mailgun, sendgrid, mailchimp, substack, actblue, ngpvan, etc.) OR no other entity uses that domain (\`SELECT count(*) FROM app.entity_address WHERE address LIKE \\'%@\\' || <domain>\` < 3), ALSO add a \`from_domain ends_with <domain>\` block rule. Otherwise skip the domain rule and only block the specific address.');
    lines.push('');
    for (const c of marketing) {
      lines.push('- \`' + c.factId + '\` "' + c.originalTitle + '"');
    }
    lines.push('');
    lines.push('After applying, report: (a) factoids soft-deleted, (b) addresses blocked, (c) domains blocked (if any), (d) any factoids that had no associated addresses so could only be soft-deleted.');
    lines.push('');
  }

  if (demotions.length > 0) {
    lines.push('## Demotions (these are not Persons)');
    lines.push('');
    for (const c of demotions) {
      const newName = c.renamed ? ' — also rename to "' + c.currentName + '"' : '';
      const typePart = c.correctType
        ? 'set factoid_type = \\'' + c.correctType + '\\''
        : 'set factoid_type = NULL (let the next type sweep re-classify)';
      lines.push('- \`' + c.factId + '\` "' + c.originalTitle + '": ' + typePart + newName);
    }
    lines.push('');
  }

  if (renames.length > 0) {
    lines.push('## Renames');
    lines.push('');
    for (const c of renames) {
      lines.push('- \`' + c.factId + '\` "' + c.originalTitle + '" → "' + c.currentName + '"');
    }
    lines.push('');
  }

  if (newFacts.length > 0) {
    lines.push('## New child facts to create');
    lines.push('');
    lines.push('For each of the following, INSERT a new row into \`app.fact\` with \`is_factoid=false\`, \`parent_factoid_id\` set to the listed person, \`memory_type=\\'long_term\\'\`, \`status=\\'raw\\'\`, \`is_active=true\`, \`content\` set to the fact text, and a short generated \`title\`.');
    lines.push('');
    for (const c of newFacts) {
      const name = c.renamed ? c.currentName : c.originalTitle;
      lines.push('- under \`' + c.factId + '\` "' + name + '":');
      for (const f of c.addFacts) {
        lines.push('  - ' + f);
      }
    }
    lines.push('');
  }

  lines.push('Please apply these changes and report what you did. If any row looks wrong, ask me before proceeding on that row.');

  const text = lines.join('\\n');
  navigator.clipboard.writeText(text).then(() => {
    showToast('Prompt copied to clipboard (' + changes.length + ' changes)');
  }, (err) => {
    showToast('Clipboard copy failed — see console');
    console.log('=== SUBMIT PROMPT ===');
    console.log(text);
  });
});

updateChangeCount();
</script>
</body>
</html>
`;

const outDir = join(homedir(), "willow-runtime-workspace", "brain-map");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `person-cleanup-${stamp}.html`);
await Bun.write(outPath, html);
console.log(`wrote ${outPath}`);
console.log(`  ${people.length} people · ${children.length} child facts`);
