// Load/upsert/update folder_profile rows.

import { sql } from "../config";
import type { FolderProfile } from "./types";

function rowToProfile(r: any): FolderProfile {
  return {
    name: r.name,
    mailbox_id: r.mailbox_id ?? null,
    parent_path: r.parent_path,
    description: r.description,
    llm_hint: r.llm_hint ?? null,
    example_subjects: (r.example_subjects ?? []) as string[],
    example_senders: (r.example_senders ?? []) as string[],
    enabled: r.enabled,
  };
}

export async function listProfiles(includeDisabled = false): Promise<FolderProfile[]> {
  const rows = includeDisabled
    ? await sql`SELECT * FROM app.folder_profile ORDER BY name`
    : await sql`SELECT * FROM app.folder_profile WHERE enabled = true ORDER BY name`;
  return (rows as unknown as any[]).map(rowToProfile);
}

export async function getProfile(name: string): Promise<FolderProfile | null> {
  const rows = await sql`SELECT * FROM app.folder_profile WHERE name = ${name}`;
  if ((rows as unknown as any[]).length === 0) return null;
  return rowToProfile((rows as unknown as any[])[0]);
}

export async function createProfile(p: {
  name: string;
  description: string;
  llm_hint?: string | null;
  example_subjects?: string[];
  example_senders?: string[];
  mailbox_id?: string | null;
  enabled?: boolean;
}): Promise<FolderProfile> {
  const rows = await sql`
    INSERT INTO app.folder_profile
      (name, mailbox_id, description, llm_hint, example_subjects, example_senders, enabled)
    VALUES (
      ${p.name},
      ${p.mailbox_id ?? null},
      ${p.description},
      ${p.llm_hint ?? null},
      ${p.example_subjects ?? []},
      ${p.example_senders ?? []},
      ${p.enabled ?? true}
    )
    RETURNING *
  `;
  return rowToProfile((rows as unknown as any[])[0]);
}

export async function updateProfile(
  name: string,
  patch: Partial<Pick<FolderProfile, "description" | "llm_hint" | "enabled">>
): Promise<FolderProfile | null> {
  const rows = await sql`
    UPDATE app.folder_profile SET
      description = COALESCE(${patch.description ?? null}, description),
      llm_hint    = CASE WHEN ${patch.llm_hint !== undefined} THEN ${patch.llm_hint ?? null} ELSE llm_hint END,
      enabled     = COALESCE(${patch.enabled ?? null}, enabled),
      updated_at  = now()
    WHERE name = ${name}
    RETURNING *
  `;
  if ((rows as unknown as any[]).length === 0) return null;
  return rowToProfile((rows as unknown as any[])[0]);
}

export async function disableProfile(name: string): Promise<boolean> {
  const rows = await sql`
    UPDATE app.folder_profile SET enabled = false, updated_at = now()
    WHERE name = ${name} RETURNING name
  `;
  return (rows as unknown as any[]).length > 0;
}

export async function appendExampleSubject(name: string, subject: string): Promise<void> {
  await sql`
    UPDATE app.folder_profile
    SET example_subjects = array_append(example_subjects, ${subject}),
        updated_at = now()
    WHERE name = ${name} AND NOT (${subject} = ANY(example_subjects))
  `;
}

export async function appendExampleSender(name: string, sender: string): Promise<void> {
  await sql`
    UPDATE app.folder_profile
    SET example_senders = array_append(example_senders, ${sender.toLowerCase()}),
        updated_at = now()
    WHERE name = ${name} AND NOT (${sender.toLowerCase()} = ANY(example_senders))
  `;
}
