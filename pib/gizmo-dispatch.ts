import { sql } from "./config";
import { createLogger } from "./logger";
import { writeMcpConfig, runClaudeP } from "./action";
import { unlinkSync } from "fs";

const log = createLogger("pib.gizmo");

interface GizmoRow {
  id: string;
  slug: string;
  title: string;
  data_context: Record<string, unknown>;
  action_prompt: string;
  return_channel: string;
  status: string;
  submission: Record<string, unknown> | null;
}

export async function executeGizmoDispatch(slug: string): Promise<void> {
  const [g] = (await sql`
    SELECT id, slug, title, data_context, action_prompt, return_channel, status, submission
    FROM app.gizmo
    WHERE slug = ${slug}
  `) as unknown as GizmoRow[];

  if (!g) {
    log.warn(`Gizmo "${slug}" not found`);
    return;
  }
  if (g.status !== "submitted") {
    log.info(`Gizmo "${slug}" status is ${g.status}, skipping dispatch`);
    return;
  }

  const prompt = composePrompt(g);
  const mcpConfigPath = writeMcpConfig();
  const start = Date.now();

  try {
    log.info(`Dispatching Gizmo "${slug}" (${g.title}) → ${g.return_channel}`);
    const result = await runClaudeP(prompt, mcpConfigPath);
    log.info(`Gizmo "${slug}" dispatched in ${Date.now() - start}ms: ${result.slice(0, 200)}`);

    await sql`
      UPDATE app.gizmo
      SET status = 'dispatched', dispatched_at = now()
      WHERE id = ${g.id}
    `;
  } catch (err) {
    log.error(`Gizmo "${slug}" dispatch failed: ${(err as Error).message}`);
    throw err;
  } finally {
    try { unlinkSync(mcpConfigPath); } catch {}
  }
}

function composePrompt(g: GizmoRow): string {
  return [
    g.action_prompt,
    "",
    "## User submission",
    JSON.stringify(g.submission ?? {}, null, 2),
    "",
    "## Original context",
    JSON.stringify(g.data_context ?? {}, null, 2),
    "",
    "## Return channel",
    g.return_channel,
    "Send your result there when done. Be concise.",
  ].join("\n");
}

export async function sweepExpiredGizmos(): Promise<number> {
  const result = await sql`
    UPDATE app.gizmo
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < now()
    RETURNING id
  `;
  return result.length;
}
