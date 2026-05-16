import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile } from "fs/promises";
import { join } from "path";
import { createHmac, timingSafeEqual } from "crypto";
import { sql } from "../db.js";

interface GizmoRow {
  id: string;
  slug: string;
  title: string;
  body_html: string;
  data_context: Record<string, unknown>;
  action_prompt: string;
  return_channel: string;
  hmac_token: string;
  status: "pending" | "submitted" | "dispatched" | "expired" | "cancelled";
  submission: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date;
  dispatched_at: Date | null;
}

const SIGNING_KEY = process.env.GIZMO_SIGNING_KEY ?? "willow-gizmo-dev-key-change-me";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function expectedToken(slug: string): string {
  return createHmac("sha256", SIGNING_KEY).update(slug).digest("hex");
}

function validToken(slug: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const want = Buffer.from(expectedToken(slug), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(supplied, "hex");
  } catch {
    return false;
  }
  if (got.length !== want.length) return false;
  return timingSafeEqual(want, got);
}

async function loadGizmo(slug: string): Promise<GizmoRow | null> {
  const rows = (await sql`
    SELECT id, slug, title, body_html, data_context, action_prompt,
           return_channel, hmac_token, status, submission,
           created_at, expires_at, dispatched_at
    FROM app.gizmo
    WHERE slug = ${slug}
  `) as unknown as GizmoRow[];
  return rows[0] ?? null;
}

function parseFormBody(body: string): Record<string, string | string[]> {
  const params = new URLSearchParams(body);
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

// ── Views ───────────────────────────────────────────────────────────────────

interface PageOpts {
  title: string;
  bodyHtml: string;
  status?: number;
}

function renderPage({ title, bodyHtml }: PageOpts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Willow</title>
<link rel="stylesheet" href="/gizmo-assets/_gizmo.css">
<script src="/gizmo-assets/htmx.min.js" defer></script>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

function formView(g: GizmoRow): string {
  const body = `
<header><h1>${escapeHtml(g.title)}</h1></header>
<form hx-post="/gizmo/${encodeURIComponent(g.slug)}/submit?t=${encodeURIComponent(g.hmac_token)}"
      hx-swap="outerHTML"
      method="post"
      action="/gizmo/${encodeURIComponent(g.slug)}/submit?t=${encodeURIComponent(g.hmac_token)}">
${g.body_html}
<footer class="actions">
  <button type="submit">Submit</button>
</footer>
</form>
<script type="application/json" id="gizmo-data">${escapeJsonForScript(g.data_context)}</script>
`;
  return renderPage({ title: g.title, bodyHtml: body });
}

function processingView(g: GizmoRow): string {
  const body = `
<header><h1>${escapeHtml(g.title)}</h1></header>
<div class="notice success">
  <strong>Got it.</strong>
  <p>Willow is working on this. You'll get the result on ${escapeHtml(prettyChannel(g.return_channel))}.</p>
</div>
<p class="meta-line">You can close this page.</p>
`;
  return renderPage({ title: g.title, bodyHtml: body });
}

function doneView(g: GizmoRow): string {
  const body = `
<header><h1>${escapeHtml(g.title)}</h1></header>
<div class="notice success">
  <strong>Done.</strong>
  <p>Willow finished and sent the result to ${escapeHtml(prettyChannel(g.return_channel))}.</p>
</div>
<p class="meta-line">You can close this page.</p>
`;
  return renderPage({ title: g.title, bodyHtml: body });
}

function expiredView(g: GizmoRow): string {
  const body = `
<header><h1>${escapeHtml(g.title)}</h1></header>
<div class="notice warn">
  <strong>This Gizmo expired.</strong>
  <p>Ask Willow to make a fresh one if you still need it.</p>
</div>
`;
  return renderPage({ title: g.title, bodyHtml: body, status: 410 });
}

function cancelledView(g: GizmoRow): string {
  const body = `
<header><h1>${escapeHtml(g.title)}</h1></header>
<div class="notice warn">
  <strong>This Gizmo was cancelled.</strong>
</div>
`;
  return renderPage({ title: g.title, bodyHtml: body, status: 410 });
}

function notFoundView(): string {
  return renderPage({
    title: "Not found",
    bodyHtml: `<header><h1>Not found</h1></header><p>This Gizmo does not exist.</p>`,
  });
}

function forbiddenView(): string {
  return renderPage({
    title: "Forbidden",
    bodyHtml: `<header><h1>Forbidden</h1></header><p>This link is not valid.</p>`,
  });
}

function prettyChannel(channel: string): string {
  if (channel.startsWith("imessage:")) return "iMessage";
  if (channel.startsWith("slack:")) return "Slack";
  if (channel.startsWith("claude-p:")) return "your Willow session";
  return channel;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function gizmoRoutes(fastify: FastifyInstance) {
  // Form-encoded body parser (htmx submits as application/x-www-form-urlencoded)
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, parseFormBody(body as string));
    }
  );

  // Static assets — read once at startup, serve from memory
  const assetDir = join(import.meta.dir, "..", "public", "gizmo-assets");
  const cssBytes = await readFile(join(assetDir, "_gizmo.css"));
  const htmxBytes = await readFile(join(assetDir, "htmx.min.js"));

  fastify.get("/gizmo-assets/_gizmo.css", async (_req, reply) => {
    reply.type("text/css; charset=utf-8").header("cache-control", "public, max-age=3600");
    return cssBytes;
  });

  fastify.get("/gizmo-assets/htmx.min.js", async (_req, reply) => {
    reply.type("application/javascript; charset=utf-8").header("cache-control", "public, max-age=86400");
    return htmxBytes;
  });

  // GET /gizmo/:slug — status-aware render
  fastify.get<{ Params: { slug: string }; Querystring: { t?: string } }>(
    "/gizmo/:slug",
    async (req, reply) => {
      reply.type("text/html; charset=utf-8");

      const g = await loadGizmo(req.params.slug);
      if (!g) {
        reply.code(404);
        return notFoundView();
      }

      if (!validToken(g.slug, req.query.t)) {
        reply.code(403);
        return forbiddenView();
      }

      if (g.status === "pending" && g.expires_at.getTime() < Date.now()) {
        await sql`UPDATE app.gizmo SET status = 'expired' WHERE id = ${g.id} AND status = 'pending'`;
        reply.code(410);
        return expiredView({ ...g, status: "expired" });
      }

      switch (g.status) {
        case "pending":    return formView(g);
        case "submitted":  return processingView(g);
        case "dispatched": return doneView(g);
        case "expired":    reply.code(410); return expiredView(g);
        case "cancelled":  reply.code(410); return cancelledView(g);
      }
    }
  );

  // POST /gizmo/:slug/submit — accept submission, enqueue dispatch
  fastify.post<{
    Params: { slug: string };
    Querystring: { t?: string };
    Body: Record<string, string | string[]>;
  }>("/gizmo/:slug/submit", async (req, reply) => {
    reply.type("text/html; charset=utf-8");

    const g = await loadGizmo(req.params.slug);
    if (!g) {
      reply.code(404);
      return notFoundView();
    }

    if (!validToken(g.slug, req.query.t)) {
      reply.code(403);
      return forbiddenView();
    }

    if (g.status !== "pending") {
      // Idempotent: replay the right view for the current status
      if (g.status === "submitted")  return processingView(g);
      if (g.status === "dispatched") return doneView(g);
      if (g.status === "expired")    { reply.code(410); return expiredView(g); }
      if (g.status === "cancelled")  { reply.code(410); return cancelledView(g); }
    }

    if (g.expires_at.getTime() < Date.now()) {
      await sql`UPDATE app.gizmo SET status = 'expired' WHERE id = ${g.id} AND status = 'pending'`;
      reply.code(410);
      return expiredView({ ...g, status: "expired" });
    }

    const submission = req.body ?? {};

    await sql`
      UPDATE app.gizmo
      SET status = 'submitted', submission = ${submission as Record<string, unknown>}
      WHERE id = ${g.id} AND status = 'pending'
    `;

    await sql`
      SELECT graphile_worker.add_job(
        'gizmo_dispatch',
        ${{ slug: g.slug } as Record<string, unknown>}
      )
    `;

    return processingView({ ...g, status: "submitted", submission });
  });

  // DELETE /gizmo/:slug — cancel (called by MCP cancel_gizmo)
  fastify.delete<{ Params: { slug: string } }>("/gizmo/:slug", async (req, reply) => {
    const result = await sql`
      UPDATE app.gizmo
      SET status = 'cancelled'
      WHERE slug = ${req.params.slug} AND status = 'pending'
      RETURNING id
    `;
    if (result.length === 0) {
      reply.code(404);
      return { error: "not found or not pending" };
    }
    return { ok: true };
  });
}

export type { GizmoRow };
