# Gizmo Design

**Status:** Designed 2026-05-05. Not yet built.
**Owner:** Vineel.
**Scope:** Internal-only personal tool.

## What is a Gizmo?

A **Gizmo** is an ephemeral local web UI that Willow generates on-the-fly during a conversation (iMessage, claude-p remote, Slack) to gather structured input from the user that would be tedious to type in chat.

Example: in iMessage, "give me Amazon coworkers I should reach out to" → Willow finds 28, offers a Gizmo with checkboxes → user picks 6 → Willow creates 6 todos and confirms via iMessage.

This is the first of several planned interaction extensions. The name "Gizmo" is web-UI-shaped on purpose; future siblings (voice notes, ephemeral calendar holds, etc.) will get their own names.

## Motivation

Chat is the wrong UI for some asks:
- Multi-select from a list
- Ranking / reordering
- Structured edits across multiple fields
- Reviewing + editing a draft before sending
- Anything where typing back the answer in prose is friction

Gizmos let Willow spin up the right tiny tool for the moment, then disappear.

## End-to-end flow (Amazon folks example)

```
[iMessage] "give me Amazon coworkers I should reach out to"
    │
    ▼
[Willow conversational agent — claude-p sonnet]
    │  - memory MCP search → 28 people
    │  - replies in iMessage: "found 28, want a Gizmo to pick?"
    │
[iMessage] "yes"
    │
    ▼
[Willow agent]
    │  willow-gizmo.create_gizmo({
    │    title: "Reach out to Amazon folks",
    │    body_html: "<ul class='checklist'>...28 <li>s with <input type=checkbox name=people>...</ul>",
    │    data_context: { people: [{id, name, role}, ...28] },
    │    action_prompt: "Add the selected people as todos with source 'reach-out-amazon'. Use willow-todos MCP. Reply with one-line confirmation.",
    │    return_channel: "imessage:vineel"
    │  })
    │  → { url: "https://willow.tail-xxxx.ts.net/gizmo/amazon-folks-x7k2qp?t=...", slug, expires_at }
    │  replies in iMessage with the URL.
    │
[user clicks link on iPhone]
    │
    ▼
[Bridge GET /gizmo/:slug]
    │  validate hmac, check status=pending + not expired
    │  render formView(g) → full HTML page from base template + body_html
    │
[user checks 6 boxes, hits Submit]
    │
    ▼
[Bridge POST /gizmo/:slug/submit]
    │  validate hmac
    │  parse form-encoded body → submission JSON
    │  UPDATE gizmo SET status='submitted', submission=...
    │  enqueue graphile job 'gizmo_dispatch' with {slug}
    │  return success HTML → user sees "submitted, Willow is working on it"
    │
    ▼
[Graphile worker → gizmo_dispatch job]
    │  load gizmo row
    │  hydrate prompt:
    │     {action_prompt}
    │     ## User submission
    │     {submission JSON}
    │     ## Original context
    │     {data_context JSON}
    │     ## Return channel
    │     imessage:vineel — send your result there when done. Be concise.
    │  runClaudeP({ prompt, model: 'sonnet', mcps: scoped })
    │  Sonnet calls willow-todos.add 6 times, then notify.send_imessage("Added 6 todos: ...")
    │  UPDATE gizmo SET status='dispatched', dispatched_at=now()
    │
[iMessage] "Added 6 todos: Anna, Ben, Chris, Dana, Eli, Fran"
```

## Architecture

### Components

| Component | Location | Purpose |
|---|---|---|
| Migration | `db/migrations/010-gizmo.sql` | `app.gizmo` table + indices |
| Bridge routes | `bridge/routes/gizmo.ts` | GET render, POST submit, DELETE cancel, static assets |
| MCP server | `mcp/gizmo-mcp/` | `create_gizmo`, `get_gizmo`, `cancel_gizmo` tools |
| Graphile job | `pib/worker.ts` (extend) | `gizmo_dispatch` task — hydrates prompt, runs claude-p |
| Static assets | `bridge/public/gizmo-assets/` | `_gizmo.css`, `htmx.min.js` |
| Skill (later) | `~/.claude/.../designing-gizmos.md` | When/how to suggest Gizmos. Write after 1–2 are built. |

### Schema

```sql
-- db/migrations/010-gizmo.sql
create table app.gizmo (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,            -- "amazon-folks-x7k2qp"
  title           text not null,
  body_html       text not null,                   -- form fragment Sonnet generated
  data_context    jsonb not null default '{}',     -- read-only data shown in page
  action_prompt   text not null,                   -- nat-lang instructions for dispatch
  return_channel  text not null,                   -- "imessage:vineel" | "slack:C123" | "claude-p:session-id"
  hmac_token      text not null,                   -- url signing
  status          text not null default 'pending'
                  check (status in ('pending','submitted','dispatched','expired','cancelled')),
  submission      jsonb,                           -- form data after submit
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,            -- created_at + ttl_hours (default 24h)
  dispatched_at   timestamptz
);

create index gizmo_status_idx on app.gizmo (status, expires_at);
create index gizmo_slug_idx on app.gizmo (slug);
```

No filesystem — DB is the only source of truth. Status-aware rendering replaces file cleanup.

### Bridge routes

```
GET    /gizmo/:slug                  serve HTML (status-aware view)
POST   /gizmo/:slug/submit           accept submission, enqueue dispatch
GET    /gizmo-assets/_gizmo.css      static
GET    /gizmo-assets/htmx.min.js     static
DELETE /gizmo/:slug                  cancel (admin / mcp)
```

All routes ACL'd to Tailscale CIDR. HMAC token (`?t=...`) validated server-side.

Status-aware GET handler:

```ts
const g = await loadGizmo(slug)
if (!validHmac(slug, req.query.t)) return reply.code(403).send()
if (g.expires_at < now()) {
  if (g.status === 'pending') await markExpired(g.id)
  return reply.code(410).type('text/html').send(expiredView(g))
}
switch (g.status) {
  case 'pending':    return reply.type('text/html').send(formView(g))
  case 'submitted':  return reply.type('text/html').send(processingView(g))
  case 'dispatched': return reply.type('text/html').send(doneView(g))
  case 'cancelled':  return reply.code(410).type('text/html').send(cancelledView(g))
  case 'expired':    return reply.code(410).type('text/html').send(expiredView(g))
}
```

POST submit handler:

```ts
const submission = parseFormBody(req.body)   // { field: value | value[] }
const g = await loadGizmo(slug)
if (!validHmac(slug, req.query.t)) return reply.code(403).send()
if (g.status !== 'pending') return reply.code(409).send(alreadySubmittedView(g))
await db.gizmo.update(slug, { status: 'submitted', submission })
await graphile.addJob('gizmo_dispatch', { slug })
return reply.type('text/html').send(processingView(g))
```

### MCP server (`willow-gizmo`)

```ts
create_gizmo({
  title: string,
  body_html: string,                     // form fragment, no <html>/<head>/<body>
  data_context?: Record<string, any>,
  action_prompt: string,
  return_channel: string,
  ttl_hours?: number = 24,
}) → { url: string, slug: string, expires_at: string }

get_gizmo(slug: string) → {
  status, submission, dispatched_at, expires_at, ...
}

cancel_gizmo(slug: string) → { ok: true }
```

`create_gizmo` does:
1. Generate slug `{name-hint}-{nanoid(6)}` from title
2. Generate `hmac_token = HMAC-SHA256(slug, GIZMO_SIGNING_KEY)`
3. Insert row into `app.gizmo`
4. Return URL `https://{tailnet}/gizmo/{slug}?t={hmac_token}`

No file writing. No `wait_for_submission` — async-only per design.

### Graphile job: `gizmo_dispatch`

Mirrors `pib/action.ts` shape:

```ts
export async function gizmoDispatch({ slug }: { slug: string }) {
  const g = await loadGizmo(slug)
  if (g.status !== 'submitted') return  // idempotent

  const prompt = [
    g.action_prompt,
    '',
    '## User submission',
    JSON.stringify(g.submission, null, 2),
    '',
    '## Original context',
    JSON.stringify(g.data_context, null, 2),
    '',
    '## Return channel',
    g.return_channel,
    'Send your result there when done. Be concise.',
  ].join('\n')

  await runClaudeP({
    prompt,
    model: 'sonnet',
    mcpConfig: scopedMcpConfig(['notify','memory','triage','interests','web','todos']),
    runLogContext: { kind: 'gizmo_dispatch', gizmo_id: g.id },
  })

  await db.gizmo.update(g.id, { status: 'dispatched', dispatched_at: now() })
}
```

### Hydration

Plain string concatenation, no template engine. Sonnet handles unstructured-text-in-prompt fine, and we sidestep `{{}}` escaping when user/email data contains braces. If a specific gizmo wants tighter control, the `action_prompt` itself can reference `submission.fieldname` in prose — Sonnet figures it out.

### Expiry sweep

Nightly Graphile cron `gizmo_sweep`:
```sql
update app.gizmo set status='expired'
where status='pending' and expires_at < now();
```
DB row is retained for audit. No file unlink because there's no file.

## Frontend

### Base template

Filled at request time in `formView(g)`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{title}} · Willow</title>
  <link rel="stylesheet" href="/gizmo-assets/_gizmo.css">
  <script src="/gizmo-assets/htmx.min.js" defer></script>
</head>
<body>
  <main>
    <header><h1>{{title}}</h1></header>
    <form hx-post="/gizmo/{{slug}}/submit?t={{hmac_token}}"
          hx-swap="outerHTML">
      {{body_html}}
      <footer class="actions">
        <button type="submit">Submit</button>
      </footer>
    </form>
    <script type="application/json" id="gizmo-data">{{data_context_json}}</script>
  </main>
</body>
</html>
```

### Stylesheet — modern CSS, no Tailwind

`bridge/public/gizmo-assets/_gizmo.css`:

```css
@layer base, components;

:root {
  color-scheme: light dark;
  --bg: light-dark(#fafafa, #111);
  --fg: light-dark(#1a1a1a, #f0f0f0);
  --muted: light-dark(#666, #999);
  --accent: light-dark(#2563eb, #60a5fa);
  --border: light-dark(#e5e5e5, #2a2a2a);
  --radius: 10px;
  --space: 1rem;
  --font: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif;
}

@layer base {
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 16px/1.5 var(--font);
    padding: clamp(1rem, 4vw, 2rem);
  }
  main { max-width: 38rem; margin-inline: auto; }
  h1 { font-size: clamp(1.4rem, 4vw, 1.8rem); margin: 0 0 var(--space); }
  fieldset { border: 0; padding: 0; margin: 0 0 var(--space); }
  legend { font-weight: 600; margin-bottom: 0.5rem; }
  label { display: block; cursor: pointer; }
  input, button, textarea, select { font: inherit; }
  button {
    background: var(--accent); color: white; border: 0;
    padding: 0.75rem 1.25rem; border-radius: var(--radius);
    cursor: pointer; font-weight: 600; min-height: 44px;
  }
  button:hover { filter: brightness(1.05); }
}

@layer components {
  .checklist { list-style: none; padding: 0; margin: 0; }
  .checklist li {
    display: flex; gap: 0.75rem; align-items: flex-start;
    padding: 0.75rem; border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 0.5rem;
    cursor: pointer;
  }
  .checklist li:has(input:checked) {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 8%, transparent);
  }
  .checklist input[type=checkbox] { width: 1.25rem; height: 1.25rem; margin-top: 2px; }
  .checklist .meta { color: var(--muted); font-size: 0.9em; }
  .actions {
    position: sticky; bottom: 0;
    padding: var(--space) 0;
    background: linear-gradient(transparent, var(--bg) 30%);
  }
  .notice {
    padding: 1rem; border-radius: var(--radius);
    background: color-mix(in oklab, var(--accent) 10%, transparent);
  }
}
```

Sonnet writes semantic HTML. The `:has(input:checked)` row highlight is free with modern CSS.

### Why htmx (v1)

`<form hx-post="..." hx-swap="outerHTML">` gives clean submit + replace-with-success-html with zero JS to write. ~14kb, one CDN/static script tag. After v1 we can revisit if it's pulling its weight.

## Decisions log

| Question | Decision |
|---|---|
| Sync vs async primary | Async only |
| TTL default | 24h |
| Generation style | Freestyle HTML; promote to typed primitives only after pattern repeats 3+ times |
| Slug scheme | `{name-hint}-{nanoid(6)}` |
| Auth | HMAC token in URL query string, no UX intervention |
| Where work happens on submit | Option B — `action_prompt` on row, hydrated + dispatched via claude-p |
| Storage | DB only, no filesystem (per-gizmo HTML rendered at request time) |
| Styling | Modern CSS, hand-rolled, classless-leaning, no Tailwind |
| Form submit lib | htmx for v1 |
| Job runner | Graphile Worker (already running) |
| Network scope | Local network / Tailscale CIDR ACL |
| Naming | "Gizmo" — internal-only personal tool |

## Phasing

1. Migration `010-gizmo.sql`
2. Static assets in `bridge/public/gizmo-assets/` (`_gizmo.css`, `htmx.min.js`)
3. Bridge routes `bridge/routes/gizmo.ts` (GET, POST, status views, static)
4. Hand-test with a hardcoded gizmo row inserted via psql
5. `mcp/gizmo-mcp/` with `create_gizmo`
6. Graphile `gizmo_dispatch` job, wire to existing `runClaudeP`
7. End-to-end test via real iMessage → conversational agent → gizmo → submit → result
8. `cancel_gizmo` MCP tool + `gizmo_sweep` cron
9. Skill `designing-gizmos` (after 1–2 real Gizmos exist, so patterns are honest)

## Deferred / future

- Sync `wait_for_submission` for claude-p remote use cases (only if needed)
- Typed primitives kit (`gizmo.checkboxList`, `gizmo.ranker`, etc.) once shapes repeat
- Public access (currently local-only)
- File uploads in submissions
- Multi-step / wizard Gizmos
- Gizmo umbrella category for non-web ephemeral interactions

## Open items for build session

- Confirm bridge server already serves static dirs (or wire it up)
- Confirm `runClaudeP` shape — borrow from `pib/action.ts`
- Confirm Tailscale CIDR for ACL middleware
- Pick exact `nanoid` length (6 chars = ~1B combinations, plenty)
- Decide whether bundled `htmx.min.js` is checked into the repo or fetched at install time
