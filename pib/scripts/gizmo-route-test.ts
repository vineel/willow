#!/usr/bin/env bun
/**
 * In-process test of the Gizmo bridge routes via Fastify .inject().
 * Doesn't touch the running bridge server — spins up a fresh Fastify in-memory.
 *
 * Usage: bun run pib/scripts/gizmo-route-test.ts <slug> <token>
 */

import Fastify from "fastify";
import { gizmoRoutes } from "../../bridge/routes/gizmo";

const slug = process.argv[2];
const token = process.argv[3];

if (!slug || !token) {
  console.error("Usage: gizmo-route-test.ts <slug> <token>");
  process.exit(1);
}

const fastify = Fastify({ logger: false });
await fastify.register(gizmoRoutes);
await fastify.ready();

console.log(`\n=== GET /gizmo/${slug} (no token) ===`);
const r1 = await fastify.inject({ method: "GET", url: `/gizmo/${slug}` });
console.log(`status: ${r1.statusCode}`);
console.log(r1.body.split("\n").slice(0, 6).join("\n"));

console.log(`\n=== GET /gizmo/${slug}?t=BADTOKEN ===`);
const r2 = await fastify.inject({ method: "GET", url: `/gizmo/${slug}?t=deadbeef` });
console.log(`status: ${r2.statusCode}`);
console.log(r2.body.split("\n").slice(0, 6).join("\n"));

console.log(`\n=== GET /gizmo/${slug}?t=<valid> ===`);
const r3 = await fastify.inject({ method: "GET", url: `/gizmo/${slug}?t=${token}` });
console.log(`status: ${r3.statusCode}`);
console.log(`length: ${r3.body.length} bytes`);
console.log(r3.body.includes("<form") ? "  ✓ contains <form>" : "  ✗ no <form>");
console.log(r3.body.includes("checklist") ? "  ✓ contains checklist class" : "  ✗ no checklist class");
console.log(r3.body.includes("Alice Chen") ? "  ✓ contains people data" : "  ✗ no people data");
console.log(r3.body.includes("/gizmo-assets/_gizmo.css") ? "  ✓ links stylesheet" : "  ✗ no stylesheet");

console.log(`\n=== GET /gizmo-assets/_gizmo.css ===`);
const r4 = await fastify.inject({ method: "GET", url: "/gizmo-assets/_gizmo.css" });
console.log(`status: ${r4.statusCode}, content-type: ${r4.headers["content-type"]}, bytes: ${r4.body.length}`);

console.log(`\n=== GET /gizmo-assets/htmx.min.js ===`);
const r5 = await fastify.inject({ method: "GET", url: "/gizmo-assets/htmx.min.js" });
console.log(`status: ${r5.statusCode}, content-type: ${r5.headers["content-type"]}, bytes: ${r5.body.length}`);

console.log(`\n=== POST /gizmo/${slug}/submit?t=<valid> ===`);
const r6 = await fastify.inject({
  method: "POST",
  url: `/gizmo/${slug}/submit?t=${token}`,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: "people=alice&people=carol&note=test+submission",
});
console.log(`status: ${r6.statusCode}`);
console.log(r6.body.includes("Got it") ? "  ✓ shows processing view" : "  ✗ no processing view");
console.log(r6.body.split("\n").slice(0, 8).join("\n"));

console.log(`\n=== GET /gizmo/${slug}?t=<valid> (after submit) ===`);
const r7 = await fastify.inject({ method: "GET", url: `/gizmo/${slug}?t=${token}` });
console.log(`status: ${r7.statusCode}`);
console.log(r7.body.includes("Got it") ? "  ✓ status-aware: shows processing view" : "  ✗ wrong view");

console.log(`\n=== POST /gizmo/${slug}/submit (replay) ===`);
const r8 = await fastify.inject({
  method: "POST",
  url: `/gizmo/${slug}/submit?t=${token}`,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: "people=bob",
});
console.log(`status: ${r8.statusCode}`);
console.log(r8.body.includes("Got it") ? "  ✓ idempotent replay" : "  ✗ replay broke");

await fastify.close();

// Don't end the sql connection — pib/config.ts shares it with bridge/db.ts and
// the gizmoRoutes plugin still has a handle. But this test is short-lived; exit explicitly.
process.exit(0);
