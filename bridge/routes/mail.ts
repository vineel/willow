import type { FastifyInstance } from "fastify";
import { getSecret } from "../../pib/config";
import { getSession, getMailboxes, type JMAPMailbox } from "../../pib/jmap/session";
import { sendNotification, sendEmail } from "../../pib/jmap/notify";
import { getEmails } from "../../pib/jmap/query";
import { resolveBody } from "../../pib/jmap/body";
import type { JMAPSession, JMAPEmail } from "../../pib/jmap/types";

interface Recipient {
  email: string;
  name?: string;
}

interface MailSendBody {
  to?: Recipient[];
  subject?: string;
  body_text?: string;
  body_html?: string;
}

let cachedSession: JMAPSession | null = null;
let cachedDraftsId: string | null = null;
let cachedToken: string | null = null;
let cachedMailboxes: JMAPMailbox[] | null = null;

async function ensureSession() {
  if (cachedSession && cachedDraftsId && cachedToken && cachedMailboxes) {
    return {
      session: cachedSession,
      draftsId: cachedDraftsId,
      token: cachedToken,
      mailboxes: cachedMailboxes,
    };
  }
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");
  cachedSession = session;
  cachedDraftsId = drafts.id;
  cachedToken = token;
  cachedMailboxes = mailboxes;
  return { session, draftsId: drafts.id, token, mailboxes };
}

// Fastmail web URLs look like:
//   https://app.fastmail.com/mail/<Folder>/<threadId>.<emailId>?u=<acctSuffix>
// JMAP rejects IDs containing '.', so the segment after the dot is the email ID.
const FASTMAIL_URL_RE = /\/mail\/([^/]+)\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/;

function parseFastmailUrl(url: string): { folder: string; threadId: string; emailId: string } | null {
  const m = FASTMAIL_URL_RE.exec(url);
  if (!m) return null;
  return { folder: m[1], threadId: m[2], emailId: m[3] };
}

function pickBody(email: JMAPEmail, kind: "text" | "html"): string | null {
  const parts = kind === "text" ? email.textBody : email.htmlBody;
  if (!parts || parts.length === 0) return null;
  // Concatenate all parts of the requested type, in order.
  const pieces: string[] = [];
  for (const part of parts) {
    const v = email.bodyValues?.[part.partId]?.value;
    if (v) pieces.push(v);
  }
  return pieces.length > 0 ? pieces.join("\n") : null;
}

function normalizeEmail(email: JMAPEmail, mailboxes: JMAPMailbox[]) {
  const mboxIndex = new Map(mailboxes.map((m) => [m.id, m]));
  const mboxNames = Object.keys(email.mailboxIds ?? {}).map((id) => {
    const mb = mboxIndex.get(id);
    return mb ? { id, name: mb.name, role: mb.role } : { id, name: null, role: null };
  });
  const bodyText = pickBody(email, "text");
  const bodyHtml = pickBody(email, "html");
  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    replyTo: email.replyTo,
    receivedAt: email.receivedAt,
    keywords: Object.keys(email.keywords ?? {}),
    mailboxes: mboxNames,
    bodyText,
    bodyHtml,
    preview: bodyText ? bodyText.slice(0, 280) : null,
    attachments: (email.attachments ?? []).map((a) => ({
      name: a.name,
      mimeType: a.type,
      size: a.size,
      blobId: a.blobId,
    })),
  };
}

function isValidRecipient(r: unknown): r is Recipient {
  if (typeof r !== "object" || r === null) return false;
  const rec = r as Record<string, unknown>;
  if (typeof rec.email !== "string" || rec.email.trim() === "") return false;
  if (rec.name !== undefined && typeof rec.name !== "string") return false;
  return true;
}

export async function mailRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: MailSendBody }>("/mail/send", async (req, reply) => {
    const { to, subject, body_text, body_html } = req.body ?? {};

    if (!subject || subject.trim() === "") {
      reply.status(400);
      return { error: "subject required" };
    }
    if (typeof body_text !== "string" || body_text === "") {
      reply.status(400);
      return { error: "body_text required" };
    }
    if (body_html !== undefined && typeof body_html !== "string") {
      reply.status(400);
      return { error: "body_html must be a string" };
    }
    if (to !== undefined) {
      if (!Array.isArray(to) || !to.every(isValidRecipient)) {
        reply.status(400);
        return { error: "to must be an array of { email, name? }" };
      }
    }

    const body = resolveBody(body_text, body_html);
    const { session, draftsId, token } = await ensureSession();

    if (!to || to.length === 0) {
      const result = await sendNotification(session, token, draftsId, {
        subject,
        bodyText: body.bodyText,
        bodyHtml: body.bodyHtml,
      });
      fastify.log.info(
        { kind: "notification", emailId: result.emailId, submissionId: result.submissionId },
        "mail/send"
      );
      return { ok: true, kind: "notification", ...result };
    }

    const result = await sendEmail(session, token, draftsId, {
      to,
      subject,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
    });
    fastify.log.info(
      {
        kind: "email",
        recipients: to.map((r) => r.email),
        emailId: result.emailId,
        submissionId: result.submissionId,
      },
      "mail/send"
    );
    return { ok: true, kind: "email", ...result };
  });

  fastify.post<{ Body: { url?: string; id?: string } }>(
    "/mail/get",
    async (req, reply) => {
      const { url, id } = req.body ?? {};

      let emailId: string | null = null;
      let parsedFolder: string | null = null;
      let parsedThreadId: string | null = null;

      if (typeof id === "string" && id.trim() !== "") {
        emailId = id.trim();
      } else if (typeof url === "string" && url.trim() !== "") {
        const parsed = parseFastmailUrl(url);
        if (!parsed) {
          reply.status(400);
          return {
            error:
              "could not parse url — expected /mail/<folder>/<threadId>.<emailId>",
          };
        }
        emailId = parsed.emailId;
        parsedFolder = parsed.folder;
        parsedThreadId = parsed.threadId;
      } else {
        reply.status(400);
        return { error: "either 'url' or 'id' is required" };
      }

      const { session, token, mailboxes } = await ensureSession();
      const emails = await getEmails(session, token, [emailId]);

      if (emails.length === 0) {
        reply.status(404);
        return { error: "email not found", id: emailId };
      }

      const normalized = normalizeEmail(emails[0], mailboxes);
      fastify.log.info(
        { kind: "get", id: emailId, subject: normalized.subject },
        "mail/get"
      );
      return {
        ok: true,
        email: normalized,
        sourceUrl: url ?? null,
        parsedFolder,
        parsedThreadId,
      };
    }
  );
}
