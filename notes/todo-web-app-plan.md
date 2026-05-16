# Mobile-First Todo Web App

## Context

Willow already manages todos in `app.todo` and exposes them through Slack (interactive cards via `/todos`) and the daily digest email. There is no web UI. The user wants a phone-friendly page they can pull up on the home network to swipe through their open todo list — Done | Top | Bot | Edit per row, plus a full-swipe-left shortcut for Done. The link will sit at the bottom of the daily digest so they can tap straight from email into the list. No auth (Tailscale / LAN handles the boundary). Deployment target is the Mac Mini named `terokNor`.

The implementation extends the existing Fastify bridge (`bridge/server.ts`, port 8787). One new route file serves both the HTML page and the JSON API. One small migration adds a manual-ordering column (Top/Bot reposition by adjusting `sort_order`). No build step, no template engine, no frontend framework — vanilla pointer-event JS in an inlined `<script>`. The digest gets a tiny footer block in both text and HTML versions.

Add-todo is **out of scope for v1** — Slack and email remain the intake channels, matching the user's framing ("the same list Willow manages").

## Files to Create

### 1. `db/migrations/008-todo-sort-order.sql`

```sql
BEGIN;

ALTER TABLE app.todo
  ADD COLUMN sort_order double precision NOT NULL DEFAULT 0;

CREATE INDEX idx_todo_sort_order
  ON app.todo (sort_order DESC, created_at DESC)
  WHERE status = 'open';

COMMIT;
```

`double precision` keeps Top/Bot math (`MAX+1` / `MIN-1`) cheap. Default 0 means existing rows tie until manually pinned, then break to `created_at DESC`.

### 2. `bridge/routes/todos.ts`

Single Fastify route module, mirroring the other `bridge/routes/*.ts` files. Uses `import { sql } from "../db.js"`. Exports `async function todoRoutes(fastify)`.

**Routes:**

| Method | Path | Purpose |
|---|---|---|
| GET  | `/todos`             | HTML list page (server-rendered open-todo `<li>`s) |
| GET  | `/todos/edit/:id`    | HTML edit form (textarea title, textarea description, priority select, due_date) |
| GET  | `/api/todos`         | JSON list — `{ todos: [{ id, title, priority, dueDate, tags, sortOrder }] }` |
| POST | `/api/todos/:id/done`   | `UPDATE status='done', completed_at=now()` |
| POST | `/api/todos/:id/top`    | `sort_order = (SELECT COALESCE(MAX(sort_order),0)+1 FROM app.todo WHERE status='open')` |
| POST | `/api/todos/:id/bottom` | `sort_order = (SELECT COALESCE(MIN(sort_order),0)-1 FROM app.todo WHERE status='open')` |
| POST | `/api/todos/:id`        | JSON body `{ title, description?, priority?, dueDate? }` — used by the edit page's Save (avoids needing `@fastify/formbody`) |

**List query** (used by `GET /todos` server-render and `GET /api/todos`):

```sql
SELECT id, title, description, priority, due_date, tags, sort_order
FROM app.todo
WHERE status = 'open'
ORDER BY sort_order DESC,
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         due_date ASC NULLS LAST,
         created_at DESC
```

**HTML page structure:**

- `<meta name="viewport" content="width=device-width,initial-scale=1">`, `<meta name="theme-color" content="#fafafa">`
- Inline `<style>`: system font stack; `<ul>` no padding; each `<li>` has `position: relative; overflow: hidden; touch-action: pan-y`; foreground `.row` is `transform: translateX(0)` with `transition: transform .2s ease`; `.actions` absolutely positioned at `right:0`, width 280px, four 70px buttons (Done | Top | Bot | Edit) with min-height 56px for tap targets.
- Inline `<script>` implements swipe via Pointer Events:
  - `pointerdown` → record `startX`, `startY`, no transform yet.
  - `pointermove` → on first 8px decide axis (lock horizontal vs let vertical scroll). If horizontal: `setPointerCapture`, translate `.row` to `min(0, dx)`.
  - `pointerup`/`pointercancel`:
    - `dx <= -rowWidth * 0.75` → animate row to `-rowWidth`, POST `/api/todos/:id/done`, collapse `<li>` height to 0, remove.
    - `-rowWidth*0.75 < dx <= -100` → snap to `translateX(-280px)` (action bar revealed); track as the single "open row" (close any other open row first).
    - else → snap back to 0.
  - Action buttons (in `.actions`):
    - **Done** → same animation as full-swipe.
    - **Top** / **Bot** → POST then `fetch('/api/todos')` and re-render `<ul>`.
    - **Edit** → `location.href = '/todos/edit/' + id`.
  - Document-level click handler closes any open row when tapping outside.

**Edit page (`GET /todos/edit/:id`)** — small standalone HTML form: title `<textarea>` (multi-line so long titles wrap), description `<textarea>`, priority `<select>` (low/normal/high/urgent), due_date `<input type="date">`, **Save** button (inline JS does `fetch('/api/todos/:id', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(...)})` then `location.href='/todos'`), **Cancel** link `<a href="/todos">`.

## Files to Modify

### 3. `bridge/server.ts`

After the existing `await fastify.register(conversationRoutes)` line, add:

```ts
import { todoRoutes } from "./routes/todos.js";
// …
await fastify.register(todoRoutes);
```

### 4. `bridge/config.ts`

Add to the config object so the bridge logs the public URL on startup:

```ts
publicUrl: process.env.WILLOW_PUBLIC_URL ?? "http://terokNor.local:8787",
```

### 5. `pib/digest.ts`

Three small surgical changes:

**a. Top of file:**

```ts
const PUBLIC_URL = process.env.WILLOW_PUBLIC_URL ?? "http://terokNor.local:8787";
```

(Read env directly — digest.ts shouldn't import from `bridge/config.ts`; PIB and the bridge are independent processes. One-line duplication beats a cross-package import.)

**b. `getPendingTodos()`** — change the `ORDER BY` to match the web app order so the email and the page agree:

```sql
ORDER BY sort_order DESC,
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         due_date ASC NULLS LAST
```

**c. Footer in `sendDigest()`** — currently `sendDigest` does:

```ts
bodyHtml = bodyHtml.replace("</div>", formatCalDigestHtml(calSection) + "</div>");
```

Change to compose footer alongside cal in one pass so the footer always lands inside the outer `<div>` after both groups and cal:

```ts
const footerHtml = `<hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px">
  <p style="color:#999;font-size:0.85em;margin:0">
    <a href="${PUBLIC_URL}/todos" style="color:#999">Manage todos</a>
  </p>`;
const calHtml = calSection ? formatCalDigestHtml(calSection) : "";
bodyHtml = bodyHtml.replace("</div>", calHtml + footerHtml + "</div>");

bodyText += (calSection ? "\n" + formatCalDigestText(calSection) : "")
         + `\n\n---\nManage todos: ${PUBLIC_URL}/todos\n`;
```

(Replaces the existing cal-only stitching block — text and HTML now share a single composition step that always includes the footer.)

## Verification

1. **Apply migration:**
   ```
   psql -d willow -f db/migrations/008-todo-sort-order.sql
   psql -d willow -c "\d app.todo" | grep sort_order
   ```

2. **Start bridge:** `bun run bridge` — confirm log line shows `terokNor.local:8787` (or override) is the public URL.

3. **API smoke** (`<id>` from `SELECT id FROM app.todo WHERE status='open' LIMIT 1`):
   ```
   curl -s localhost:8787/api/todos | jq '.todos | length'
   curl -sX POST localhost:8787/api/todos/<id>/top
   curl -sX POST localhost:8787/api/todos/<id>/bottom
   curl -sX POST localhost:8787/api/todos/<id>/done
   psql -d willow -c "SELECT status, sort_order FROM app.todo WHERE id='<id>'"
   ```

4. **Mobile browser:** open `http://terokNor.local:8787/todos` on phone.
   - Rows render in priority/sort_order order.
   - Partial swipe-left → action bar reveals at -280px and stays.
   - Full swipe-left → row animates off, status flips to `done` in DB.
   - Top → row jumps to position 1; Bot → row drops to bottom.
   - Edit → form loads, change title, Save → redirects to `/todos`, change visible.
   - Vertical scroll still works (touch-action: pan-y).

5. **Digest preview:** `bun run pib:digest:preview` — confirm last line is `Manage todos: http://terokNor.local:8787/todos`. For HTML, send a test digest (`bun run pib:digest:send` with a test recipient or pull from logs) and confirm the grey footer link appears below the calendar block, inside the outer div.

6. **End-to-end:** trigger `sendDigest()`, open the email on iPhone, tap the footer link, complete one todo via swipe, verify it's marked done in DB.

## Critical Files

- `db/migrations/008-todo-sort-order.sql` (new)
- `bridge/routes/todos.ts` (new — all routes + HTML + JS + CSS)
- `bridge/server.ts` (register `todoRoutes`)
- `bridge/config.ts` (add `publicUrl`)
- `pib/digest.ts` (sort_order in query, footer in `sendDigest`)
