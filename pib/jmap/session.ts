import type { JMAPSession } from "./types";
import { jmapRequest } from "./client";

const JMAP_SESSION_URL = "https://api.fastmail.com/.well-known/jmap";

interface JMAPSessionResponse {
  accounts: Record<string, { name: string }>;
  apiUrl: string;
  downloadUrl: string;
}

export interface JMAPMailbox {
  id: string;
  name: string;
  role: string | null;
}

export async function getSession(token: string): Promise<JMAPSession> {
  const response = await fetch(JMAP_SESSION_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`JMAP session fetch failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as JMAPSessionResponse;
  const accountId = Object.keys(data.accounts)[0];

  if (!accountId) {
    throw new Error("No accounts found in JMAP session");
  }

  return {
    accountId,
    apiUrl: data.apiUrl,
    downloadUrl: data.downloadUrl,
  };
}

export async function getMailboxes(
  session: JMAPSession,
  token: string
): Promise<JMAPMailbox[]> {
  const response = await jmapRequest(session.apiUrl, token, [
    [
      "Mailbox/get",
      { accountId: session.accountId, properties: ["id", "name", "role"] },
      "m1",
    ],
  ]);

  const [, result] = response.methodResponses[0];
  return result.list as JMAPMailbox[];
}

export function findMailbox(
  mailboxes: JMAPMailbox[],
  folder: string
): JMAPMailbox {
  // Try matching by JMAP role first (inbox, sent, drafts, trash, etc.)
  const byRole = mailboxes.find(
    (m) => m.role?.toLowerCase() === folder.toLowerCase()
  );
  if (byRole) return byRole;

  // Then try matching by name (case-insensitive)
  const byName = mailboxes.find(
    (m) => m.name.toLowerCase() === folder.toLowerCase()
  );
  if (byName) return byName;

  const available = mailboxes
    .map((m) => `"${m.name}"${m.role ? ` (role: ${m.role})` : ""}`)
    .join(", ");
  throw new Error(`Mailbox "${folder}" not found. Available: ${available}`);
}
