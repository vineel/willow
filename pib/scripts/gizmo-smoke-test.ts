#!/usr/bin/env bun
/**
 * Smoke test for the Gizmo flow.
 * Inserts a test gizmo, prints the URL, lets you curl it.
 *
 * Usage: bun run pib/scripts/gizmo-smoke-test.ts
 */

import { createHmac } from "crypto";
import { sql } from "../config";

const SIGNING_KEY = process.env.GIZMO_SIGNING_KEY ?? "willow-gizmo-dev-key-change-me";
const PUBLIC_URL = process.env.WILLOW_PUBLIC_URL ?? "http://terokNor.local:8787";

const slug = `smoke-test-${Math.random().toString(36).slice(2, 8)}`;
const token = createHmac("sha256", SIGNING_KEY).update(slug).digest("hex");

const body_html = `
<fieldset>
  <legend>Pick which Amazon folks to reach out to</legend>
  <ul class="checklist">
    <li><label><input type="checkbox" name="people" value="alice"> Alice Chen <span class="meta">SDE, Retail</span></label></li>
    <li><label><input type="checkbox" name="people" value="bob"> Bob Patel <span class="meta">PM, AWS</span></label></li>
    <li><label><input type="checkbox" name="people" value="carol"> Carol Singh <span class="meta">EM, Alexa</span></label></li>
    <li><label><input type="checkbox" name="people" value="dave"> Dave Lee <span class="meta">Sr. SDE, Prime</span></label></li>
  </ul>
</fieldset>
<fieldset>
  <legend>Note (optional)</legend>
  <textarea name="note" placeholder="Anything specific to mention?"></textarea>
</fieldset>
`;

const data_context = {
  people: [
    { id: "alice", name: "Alice Chen", role: "SDE, Retail" },
    { id: "bob", name: "Bob Patel", role: "PM, AWS" },
    { id: "carol", name: "Carol Singh", role: "EM, Alexa" },
    { id: "dave", name: "Dave Lee", role: "Sr. SDE, Prime" },
  ],
};

const action_prompt =
  "This is a smoke test. Do nothing destructive. Just send a brief iMessage to Vineel summarizing what was selected. Do NOT create todos.";

const [row] = (await sql`
  INSERT INTO app.gizmo (
    slug, title, body_html, data_context, action_prompt, return_channel,
    hmac_token, expires_at
  ) VALUES (
    ${slug},
    ${"Smoke test — Amazon folks"},
    ${body_html},
    ${data_context as Record<string, unknown>},
    ${action_prompt},
    ${"imessage:vineel"},
    ${token},
    now() + interval '1 hour'
  )
  RETURNING slug, expires_at
`) as unknown as Array<{ slug: string; expires_at: Date }>;

const url = `${PUBLIC_URL}/gizmo/${encodeURIComponent(row.slug)}?t=${encodeURIComponent(token)}`;

console.log("Created smoke-test Gizmo:");
console.log(`  slug:    ${row.slug}`);
console.log(`  token:   ${token}`);
console.log(`  expires: ${row.expires_at.toISOString()}`);
console.log(`  URL:     ${url}`);
console.log("");
console.log("Try:");
console.log(`  curl -s '${url}' | head -50`);
console.log(`  curl -s -X POST '${url.replace("/gizmo/", "/gizmo/").replace("?", "/submit?")}' \\`);
console.log(`    -H 'content-type: application/x-www-form-urlencoded' \\`);
console.log(`    -d 'people=alice&people=carol&note=hello' | head -30`);

await sql.end();
