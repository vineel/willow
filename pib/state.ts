import { sql } from "./config";

interface SyncState {
  stateToken: string;
  mailboxId: string;
}

export async function getSyncState(
  sourceType: string,
  folder: string
): Promise<SyncState | null> {
  const rows = await sql`
    SELECT state_token, metadata->>'mailboxId' as mailbox_id
    FROM app.source_adapter_state
    WHERE source_type = ${sourceType} AND folder = ${folder}
  `;

  if (rows.length === 0 || !rows[0].state_token) return null;

  return {
    stateToken: rows[0].state_token,
    mailboxId: rows[0].mailbox_id,
  };
}

export async function saveSyncState(
  sourceType: string,
  folder: string,
  stateToken: string,
  mailboxId: string
): Promise<void> {
  await sql`
    INSERT INTO app.source_adapter_state (source_type, folder, state_token, last_run_at, metadata, updated_at)
    VALUES (${sourceType}, ${folder}, ${stateToken}, now(), ${sql.json({ mailboxId })}, now())
    ON CONFLICT (source_type, folder) DO UPDATE SET
      state_token = EXCLUDED.state_token,
      last_run_at = now(),
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `;
}
