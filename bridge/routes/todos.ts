import type { FastifyInstance } from "fastify";
import { sql } from "../db.js";

interface TodoRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  due_date: Date | null;
  tags: string[] | null;
  sort_order: number;
}

interface TodoJson {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: string | null;
  tags: string[];
  sortOrder: number;
}

function toJson(r: TodoRow): TodoJson {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
    tags: (r.tags ?? []) as string[],
    sortOrder: r.sort_order,
  };
}

async function listOpen(): Promise<TodoJson[]> {
  const rows = (await sql`
    SELECT id, title, description, priority, due_date, tags, sort_order
    FROM app.todo
    WHERE status = 'open'
    ORDER BY sort_order DESC,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             due_date ASC NULLS LAST,
             created_at DESC
  `) as unknown as TodoRow[];
  return rows.map(toJson);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderListPage(todos: TodoJson[]): string {
  const items = todos.map(renderListItem).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#fafafa">
<title>Todos</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fafafa; color: #111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; }
  header { padding: 0; font-size: 1.1em; font-weight: 600;
    background: #fff; border-bottom: 1px solid #eee; position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; justify-content: space-between; }
  header .title { padding: 16px; }
  header .count { color: #999; font-weight: 400; font-size: 0.9em; margin-left: 8px; }
  header .add { display: block; padding: 12px 20px; color: #2563eb;
    font-size: 1.8em; font-weight: 300; line-height: 1; text-decoration: none;
    min-width: 44px; text-align: center; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { position: relative; overflow: hidden; touch-action: pan-y;
    background: #fff; border-bottom: 1px solid #eee;
    transition: height .25s ease, opacity .2s ease; }
  .row { position: relative; z-index: 1; background: #fff; padding: 14px 16px;
    transform: translateX(0); transition: transform .2s ease;
    min-height: 56px; display: flex; flex-direction: column; gap: 4px; }
  .row .title { font-size: 1em; line-height: 1.3; word-wrap: break-word; }
  .row .meta { font-size: 0.8em; color: #666; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 0.75em; font-weight: 500; }
  .badge.urgent { background: #fee; color: #b00; }
  .badge.high { background: #fef3c7; color: #92400e; }
  .badge.overdue { background: #fee; color: #b00; }
  .badge.due { background: #f3f4f6; color: #555; }
  .actions { position: absolute; top: 0; right: 0; height: 100%; width: 280px;
    display: flex; align-items: stretch; }
  .actions button { width: 70px; border: none; padding: 0; margin: 0;
    font-size: 0.9em; font-weight: 500; color: #fff;
    min-height: 56px; cursor: pointer; }
  .act-done { background: #16a34a; }
  .act-top  { background: #2563eb; }
  .act-bot  { background: #6b7280; }
  .act-edit { background: #374151; }
  .empty { padding: 48px 16px; text-align: center; color: #999; }
</style>
</head>
<body>
<header>
  <div class="title">Todos<span class="count" id="count">${todos.length}</span></div>
  <a class="add" href="/todos/new" aria-label="New todo">+</a>
</header>
<ul id="list">${items}</ul>
${todos.length === 0 ? '<div class="empty">All clear.</div>' : ""}
<script>
${listScript()}
</script>
</body>
</html>`;
}

function renderListItem(t: TodoJson): string {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = t.dueDate !== null && t.dueDate < today;
  const badges: string[] = [];
  if (overdue) badges.push('<span class="badge overdue">overdue</span>');
  if (t.priority === "urgent") badges.push('<span class="badge urgent">urgent</span>');
  else if (t.priority === "high") badges.push('<span class="badge high">high</span>');
  if (t.dueDate) badges.push(`<span class="badge due">due ${escapeHtml(t.dueDate)}</span>`);
  const meta = badges.length > 0 ? `<div class="meta">${badges.join(" ")}</div>` : "";
  return `<li data-id="${escapeHtml(t.id)}">
    <div class="actions">
      <button class="act-done" data-act="done">Done</button>
      <button class="act-top"  data-act="top">Top</button>
      <button class="act-bot"  data-act="bottom">Bot</button>
      <button class="act-edit" data-act="edit">Edit</button>
    </div>
    <div class="row">
      <div class="title">${escapeHtml(t.title)}</div>
      ${meta}
    </div>
  </li>`;
}

function listScript(): string {
  return `
const ACTION_WIDTH = 280;
const SWIPE_THRESHOLD = 0.75;
const SNAP_THRESHOLD = 100;
let openLi = null;

function getRow(li) { return li.querySelector('.row'); }

function setX(row, x) { row.style.transform = 'translateX(' + x + 'px)'; }

function snapClosed(li) {
  setX(getRow(li), 0);
  if (openLi === li) openLi = null;
}

function snapOpen(li) {
  if (openLi && openLi !== li) snapClosed(openLi);
  setX(getRow(li), -ACTION_WIDTH);
  openLi = li;
}

function removeLi(li) {
  const h = li.offsetHeight;
  li.style.height = h + 'px';
  requestAnimationFrame(() => {
    li.style.height = '0';
    li.style.opacity = '0';
    setTimeout(() => {
      li.remove();
      const c = document.getElementById('count');
      if (c) c.textContent = document.querySelectorAll('#list > li').length;
    }, 250);
  });
}

async function doDone(li) {
  const row = getRow(li);
  setX(row, -row.offsetWidth);
  try {
    await fetch('/api/todos/' + li.dataset.id + '/done', { method: 'POST' });
  } catch (e) { console.error(e); }
  removeLi(li);
}

async function doMove(li, where) {
  try {
    await fetch('/api/todos/' + li.dataset.id + '/' + where, { method: 'POST' });
    const r = await fetch('/api/todos');
    const data = await r.json();
    rerender(data.todos);
  } catch (e) { console.error(e); }
}

function rerender(todos) {
  const today = new Date().toISOString().slice(0, 10);
  const list = document.getElementById('list');
  list.innerHTML = todos.map(t => {
    const badges = [];
    const overdue = t.dueDate && t.dueDate < today;
    if (overdue) badges.push('<span class="badge overdue">overdue</span>');
    if (t.priority === 'urgent') badges.push('<span class="badge urgent">urgent</span>');
    else if (t.priority === 'high') badges.push('<span class="badge high">high</span>');
    if (t.dueDate) badges.push('<span class="badge due">due ' + escapeText(t.dueDate) + '</span>');
    const meta = badges.length ? '<div class="meta">' + badges.join(' ') + '</div>' : '';
    return '<li data-id="' + escapeAttr(t.id) + '">'
      + '<div class="actions">'
      + '<button class="act-done" data-act="done">Done</button>'
      + '<button class="act-top"  data-act="top">Top</button>'
      + '<button class="act-bot"  data-act="bottom">Bot</button>'
      + '<button class="act-edit" data-act="edit">Edit</button>'
      + '</div>'
      + '<div class="row"><div class="title">' + escapeText(t.title) + '</div>' + meta + '</div>'
      + '</li>';
  }).join('');
  openLi = null;
  document.getElementById('count').textContent = todos.length;
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let drag = null;

document.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.closest('.actions')) return;
  drag = {
    li,
    row: getRow(li),
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    axis: null,
    baseX: openLi === li ? -ACTION_WIDTH : 0,
  };
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (drag.axis === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (drag.axis === 'x') {
      try { drag.row.setPointerCapture(e.pointerId); } catch (_) {}
    } else {
      drag = null;
      return;
    }
  }
  if (drag.axis === 'x') {
    const x = Math.min(0, drag.baseX + dx);
    setX(drag.row, x);
    e.preventDefault();
  }
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (d.axis !== 'x') return;
  const dx = e.clientX - d.startX;
  const finalX = Math.min(0, d.baseX + dx);
  const w = d.row.offsetWidth;
  if (finalX <= -w * SWIPE_THRESHOLD) {
    doDone(d.li);
    return;
  }
  if (finalX <= -SNAP_THRESHOLD) {
    snapOpen(d.li);
  } else {
    snapClosed(d.li);
  }
}

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const li = btn.closest('li[data-id]');
    if (!li) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'done') doDone(li);
    else if (act === 'top') doMove(li, 'top');
    else if (act === 'bottom') doMove(li, 'bottom');
    else if (act === 'edit') location.href = '/todos/edit/' + encodeURIComponent(li.dataset.id);
    return;
  }
  if (openLi && !e.target.closest('li[data-id]')) {
    snapClosed(openLi);
  } else if (openLi) {
    const li = e.target.closest('li[data-id]');
    if (li !== openLi) snapClosed(openLi);
  }
});
`;
}

interface FormPageOpts {
  headerText: string;
  formAction: string;
  values: { title: string; description: string; priority: string; dueDate: string };
  autofocusTitle?: boolean;
}

function renderFormPage(opts: FormPageOpts): string {
  const { headerText, formAction, values, autofocusTitle } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#fafafa">
<title>${escapeHtml(headerText)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fafafa; color: #111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { padding: 16px; font-weight: 600; background: #fff; border-bottom: 1px solid #eee; }
  form { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 600px; }
  label { font-size: 0.85em; color: #555; font-weight: 500; }
  textarea, input, select { width: 100%; font: inherit; padding: 10px; border: 1px solid #ddd;
    border-radius: 6px; background: #fff; color: #111; }
  textarea { resize: vertical; min-height: 60px; }
  textarea[name="description"] { min-height: 120px; }
  .actions { display: flex; gap: 12px; margin-top: 8px; }
  button, .cancel { flex: 1; padding: 14px; font-size: 1em; font-weight: 500;
    border-radius: 8px; border: none; text-align: center; text-decoration: none; cursor: pointer; }
  button { background: #2563eb; color: #fff; }
  .cancel { background: #fff; color: #555; border: 1px solid #ddd; line-height: 1.2; }
</style>
</head>
<body>
<header>${escapeHtml(headerText)}</header>
<form id="f">
  <div>
    <label for="title">Title</label>
    <textarea id="title" name="title" rows="2" required${autofocusTitle ? " autofocus" : ""}>${escapeHtml(values.title)}</textarea>
  </div>
  <div>
    <label for="description">Description</label>
    <textarea id="description" name="description">${escapeHtml(values.description)}</textarea>
  </div>
  <div>
    <label for="priority">Priority</label>
    <select id="priority" name="priority">
      ${["low", "normal", "high", "urgent"].map(p =>
        `<option value="${p}"${p === values.priority ? " selected" : ""}>${p}</option>`
      ).join("")}
    </select>
  </div>
  <div>
    <label for="due_date">Due date</label>
    <input id="due_date" type="date" name="due_date" value="${escapeHtml(values.dueDate)}">
  </div>
  <div class="actions">
    <a class="cancel" href="/todos">Cancel</a>
    <button type="submit">Save</button>
  </div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    title: document.getElementById('title').value,
    description: document.getElementById('description').value,
    priority: document.getElementById('priority').value,
    dueDate: document.getElementById('due_date').value || null,
  };
  const r = await fetch(${JSON.stringify(formAction)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) location.href = '/todos';
  else alert('Save failed: ' + r.status);
});
</script>
</body>
</html>`;
}

export async function todoRoutes(fastify: FastifyInstance) {
  fastify.get("/todos", async (_req, reply) => {
    const todos = await listOpen();
    reply.type("text/html; charset=utf-8");
    return renderListPage(todos);
  });

  fastify.get("/todos/new", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderFormPage({
      headerText: "New todo",
      formAction: "/api/todos",
      values: { title: "", description: "", priority: "normal", dueDate: "" },
      autofocusTitle: true,
    });
  });

  fastify.get<{ Params: { id: string } }>("/todos/edit/:id", async (req, reply) => {
    const rows = (await sql`
      SELECT id, title, description, priority, due_date, tags, sort_order
      FROM app.todo
      WHERE id = ${req.params.id}
    `) as unknown as TodoRow[];
    if (rows.length === 0) {
      reply.status(404);
      return "Todo not found";
    }
    const t = toJson(rows[0]);
    reply.type("text/html; charset=utf-8");
    return renderFormPage({
      headerText: "Edit todo",
      formAction: `/api/todos/${t.id}`,
      values: {
        title: t.title,
        description: t.description ?? "",
        priority: t.priority,
        dueDate: t.dueDate ?? "",
      },
    });
  });

  fastify.get("/api/todos", async () => {
    const todos = await listOpen();
    return { todos };
  });

  fastify.post<{
    Body: { title?: string; description?: string | null; priority?: string; dueDate?: string | null };
  }>("/api/todos", async (req, reply) => {
    const { title, description, priority, dueDate } = req.body ?? {};
    if (!title || title.trim() === "") {
      reply.status(400);
      return { error: "title required" };
    }
    if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(priority)) {
      reply.status(400);
      return { error: "invalid priority" };
    }
    const result = await sql`
      INSERT INTO app.todo (title, description, priority, due_date, source, sort_order)
      VALUES (
        ${title.trim()},
        ${description ?? null},
        ${priority ?? "normal"},
        ${dueDate ?? null}::date,
        'web',
        (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM app.todo WHERE status = 'open')
      )
      RETURNING id
    `;
    return { ok: true, id: result[0].id };
  });

  fastify.post<{ Params: { id: string } }>("/api/todos/:id/done", async (req, reply) => {
    const result = await sql`
      UPDATE app.todo
      SET status = 'done', completed_at = now()
      WHERE id = ${req.params.id} AND status = 'open'
      RETURNING id
    `;
    if (result.length === 0) {
      reply.status(404);
      return { error: "not found or already done" };
    }
    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>("/api/todos/:id/top", async (req, reply) => {
    const result = await sql`
      UPDATE app.todo
      SET sort_order = (
        SELECT COALESCE(MAX(sort_order), 0) + 1
        FROM app.todo WHERE status = 'open'
      )
      WHERE id = ${req.params.id} AND status = 'open'
      RETURNING id, sort_order
    `;
    if (result.length === 0) {
      reply.status(404);
      return { error: "not found" };
    }
    return { ok: true, sortOrder: result[0].sort_order };
  });

  fastify.post<{ Params: { id: string } }>("/api/todos/:id/bottom", async (req, reply) => {
    const result = await sql`
      UPDATE app.todo
      SET sort_order = (
        SELECT COALESCE(MIN(sort_order), 0) - 1
        FROM app.todo WHERE status = 'open'
      )
      WHERE id = ${req.params.id} AND status = 'open'
      RETURNING id, sort_order
    `;
    if (result.length === 0) {
      reply.status(404);
      return { error: "not found" };
    }
    return { ok: true, sortOrder: result[0].sort_order };
  });

  fastify.post<{
    Params: { id: string };
    Body: { title?: string; description?: string | null; priority?: string; dueDate?: string | null };
  }>("/api/todos/:id", async (req, reply) => {
    const { title, description, priority, dueDate } = req.body ?? {};
    if (title !== undefined && title.trim() === "") {
      reply.status(400);
      return { error: "title cannot be empty" };
    }
    if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(priority)) {
      reply.status(400);
      return { error: "invalid priority" };
    }
    const result = await sql`
      UPDATE app.todo SET
        title       = COALESCE(${title ?? null}, title),
        description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
        priority    = COALESCE(${priority ?? null}, priority),
        due_date    = CASE WHEN ${dueDate !== undefined} THEN ${dueDate ?? null}::date ELSE due_date END
      WHERE id = ${req.params.id}
      RETURNING id
    `;
    if (result.length === 0) {
      reply.status(404);
      return { error: "not found" };
    }
    return { ok: true };
  });
}
