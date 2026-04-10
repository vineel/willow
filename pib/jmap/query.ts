import type { JMAPEmail, JMAPSession } from "./types";
import { jmapRequest } from "./client";

const EMAIL_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "replyTo",
  "subject",
  "receivedAt",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "headers",
];

const BATCH_SIZE = 50;

export interface QueryResult {
  ids: string[];
  queryState: string;
}

export interface ChangesResult {
  added: string[];
  removed: string[];
  newQueryState: string;
}

export async function queryEmails(
  session: JMAPSession,
  token: string,
  mailboxId: string,
  limit: number
): Promise<QueryResult> {
  const response = await jmapRequest(session.apiUrl, token, [
    [
      "Email/query",
      {
        accountId: session.accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
      },
      "q1",
    ],
  ]);

  const [, result] = response.methodResponses[0];
  return {
    ids: result.ids as string[],
    queryState: result.queryState as string,
  };
}

export async function queryChanges(
  session: JMAPSession,
  token: string,
  mailboxId: string,
  sinceQueryState: string
): Promise<ChangesResult> {
  const response = await jmapRequest(session.apiUrl, token, [
    [
      "Email/queryChanges",
      {
        accountId: session.accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        sinceQueryState,
      },
      "qc1",
    ],
  ]);

  const [methodName, result] = response.methodResponses[0];

  if (methodName === "error") {
    const errorType = (result as Record<string, unknown>).type as string;
    throw new QueryChangesError(errorType);
  }

  const added = (result.added as { id: string; index: number }[]).map(
    (a) => a.id
  );
  const removed = (result.removed as string[]) ?? [];

  return {
    added,
    removed,
    newQueryState: result.newQueryState as string,
  };
}

export class QueryChangesError extends Error {
  constructor(public jmapErrorType: string) {
    super(`Email/queryChanges failed: ${jmapErrorType}`);
  }
}

export async function getEmails(
  session: JMAPSession,
  token: string,
  ids: string[]
): Promise<JMAPEmail[]> {
  if (ids.length === 0) return [];

  const emails: JMAPEmail[] = [];

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const response = await jmapRequest(session.apiUrl, token, [
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: batch,
          properties: EMAIL_PROPERTIES,
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 102400,
        },
        "g1",
      ],
    ]);

    const [, result] = response.methodResponses[0];
    emails.push(...(result.list as JMAPEmail[]));
  }

  return emails;
}
