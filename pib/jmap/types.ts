// JMAP protocol types

export interface JMAPSession {
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
}

export type JMAPMethodCall = [string, Record<string, unknown>, string];

export interface JMAPResponse {
  methodResponses: [string, Record<string, unknown>, string][];
  sessionState: string;
}

// JMAP Email shape from Email/get
export interface JMAPEmailAddress {
  name: string | null;
  email: string;
}

export interface JMAPBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface JMAPBodyPart {
  partId: string;
  blobId: string;
  size: number;
  name: string | null;
  type: string;
  charset?: string;
  disposition?: string;
  cid?: string;
}

export interface JMAPEmail {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: JMAPEmailAddress[] | null;
  to: JMAPEmailAddress[] | null;
  cc: JMAPEmailAddress[] | null;
  replyTo: JMAPEmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  bodyValues: Record<string, JMAPBodyValue>;
  textBody: JMAPBodyPart[];
  htmlBody: JMAPBodyPart[];
  attachments: JMAPBodyPart[];
  headers: { name: string; value: string }[];
}

// Source-agnostic event envelope
export interface Attachment {
  name: string;
  mimeType: string;
  size: number;
  blobId: string;
}

export interface CanonicalEvent {
  id: string;
  sourceType: string;
  sourceRef: string;
  sourceMeta: Record<string, unknown>;
  receivedAt: string;
  fromEntity: {
    displayName: string;
    address: string;
    sourceType: string;
  };
  toEntities: {
    displayName: string;
    address: string;
    sourceType: string;
  }[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments: Attachment[];
}
