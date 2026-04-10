import type { JMAPEmail, CanonicalEvent, Attachment } from "./jmap/types";

function getBodyText(email: JMAPEmail): string | undefined {
  for (const part of email.textBody) {
    const value = email.bodyValues[part.partId];
    if (value) return value.value;
  }
  return undefined;
}

function getBodyHtml(email: JMAPEmail): string | undefined {
  for (const part of email.htmlBody) {
    const value = email.bodyValues[part.partId];
    if (value) return value.value;
  }
  return undefined;
}

export function normalize(email: JMAPEmail): CanonicalEvent {
  const from = email.from?.[0];

  const toEntities = [
    ...(email.to ?? []),
    ...(email.cc ?? []),
  ].map((addr) => ({
    displayName: addr.name ?? addr.email,
    address: addr.email,
    sourceType: "email",
  }));

  const attachments: Attachment[] = email.attachments.map((att) => ({
    name: att.name ?? "unnamed",
    mimeType: att.type,
    size: att.size,
    blobId: att.blobId,
  }));

  return {
    id: email.id,
    sourceType: "email",
    sourceRef: email.id,
    sourceMeta: {
      threadId: email.threadId,
      mailboxIds: email.mailboxIds,
      keywords: email.keywords,
      headers: email.headers,
      replyTo: email.replyTo,
    },
    receivedAt: email.receivedAt,
    fromEntity: {
      displayName: from?.name ?? from?.email ?? "unknown",
      address: from?.email ?? "unknown",
      sourceType: "email",
    },
    toEntities,
    subject: email.subject ?? undefined,
    bodyText: getBodyText(email),
    bodyHtml: getBodyHtml(email),
    attachments,
  };
}
