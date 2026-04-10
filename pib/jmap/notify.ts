import type { JMAPSession } from "./types";
import { jmapRequest } from "./client";

const NOTIFICATION_ADDRESS = "willow-notification@vineel.com";

interface NotificationOptions {
  subject: string;
  bodyText: string;
  bodyHtml?: string;
}

/**
 * Send a notification email via JMAP.
 *
 * Creates an email and submits it in a single JMAP request using
 * a backreference from EmailSubmission/set to Email/set.
 *
 * The email is sent from/to willow-notification@vineel.com.
 * Fastmail's server-side rule routes it to the "willow" folder.
 */
export async function sendNotification(
  session: JMAPSession,
  token: string,
  draftsMailboxId: string,
  options: NotificationOptions
): Promise<{ emailId: string; submissionId: string }> {
  const { subject, bodyText, bodyHtml } = options;

  const bodyValues: Record<string, { value: string }> = {
    text: { value: bodyText },
  };

  if (bodyHtml) {
    bodyValues.html = { value: bodyHtml };
  }

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [draftsMailboxId]: true },
    from: [{ name: "Willow", email: NOTIFICATION_ADDRESS }],
    to: [{ name: "Vineel", email: NOTIFICATION_ADDRESS }],
    subject,
    bodyValues,
    textBody: [{ partId: "text", type: "text/plain" }],
  };

  if (bodyHtml) {
    emailCreate.htmlBody = [{ partId: "html", type: "text/html" }];
  }

  const submissionCreate = {
    "willow-submit": {
      emailId: "#willow-notif",
      identityId: await getIdentityId(session, token),
    },
  };

  const response = await jmapRequest(
    session.apiUrl,
    token,
    [
      [
        "Email/set",
        {
          accountId: session.accountId,
          create: { "willow-notif": emailCreate },
        },
        "e1",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: session.accountId,
          create: submissionCreate,
          onSuccessDestroyEmail: ["#willow-submit"],
        },
        "s1",
      ],
    ],
    ["urn:ietf:params:jmap:submission"]
  );

  const [emailMethod, emailResult] = response.methodResponses[0];
  if (emailMethod === "error") {
    throw new Error(`Email/set failed: ${JSON.stringify(emailResult)}`);
  }

  const [subMethod, subResult] = response.methodResponses[1];
  if (subMethod === "error") {
    throw new Error(
      `EmailSubmission/set failed: ${JSON.stringify(subResult)}`
    );
  }

  const created = (emailResult as any).created?.["willow-notif"];
  const submitted = (subResult as any).created?.["willow-submit"];

  if (!created) {
    const notCreated = (emailResult as any).notCreated;
    throw new Error(`Failed to create email: ${JSON.stringify(notCreated)}`);
  }

  if (!submitted) {
    const notCreated = (subResult as any).notCreated;
    throw new Error(`Failed to submit email: ${JSON.stringify(notCreated)}`);
  }

  return {
    emailId: created.id,
    submissionId: submitted.id,
  };
}

/**
 * Send an email to a third party via JMAP.
 * Does NOT use onSuccessDestroyEmail — the email must survive for SMTP relay.
 */
export async function sendEmail(
  session: JMAPSession,
  token: string,
  draftsMailboxId: string,
  options: {
    to: { name?: string; email: string }[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    fromIdentity?: string; // identity ID, defaults to primary
  }
): Promise<{ emailId: string; submissionId: string }> {
  const { to, subject, bodyText, bodyHtml, fromIdentity } = options;

  const bodyValues: Record<string, { value: string }> = {
    text: { value: bodyText },
  };
  if (bodyHtml) {
    bodyValues.html = { value: bodyHtml };
  }

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [draftsMailboxId]: true },
    from: [{ name: "Willow", email: NOTIFICATION_ADDRESS }],
    to: to.map((r) => ({ name: r.name ?? r.email, email: r.email })),
    subject,
    bodyValues,
    textBody: [{ partId: "text", type: "text/plain" }],
  };

  if (bodyHtml) {
    emailCreate.htmlBody = [{ partId: "html", type: "text/html" }];
  }

  const identityId = fromIdentity ?? await getIdentityId(session, token);

  const response = await jmapRequest(
    session.apiUrl,
    token,
    [
      [
        "Email/set",
        {
          accountId: session.accountId,
          create: { "willow-send": emailCreate },
        },
        "e1",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: session.accountId,
          create: {
            "willow-send-sub": {
              emailId: "#willow-send",
              identityId,
            },
          },
          // No onSuccessDestroyEmail — email must survive for SMTP relay
        },
        "s1",
      ],
    ],
    ["urn:ietf:params:jmap:submission"]
  );

  const [emailMethod, emailResult] = response.methodResponses[0];
  if (emailMethod === "error") {
    throw new Error(`Email/set failed: ${JSON.stringify(emailResult)}`);
  }

  const [subMethod, subResult] = response.methodResponses[1];
  if (subMethod === "error") {
    throw new Error(
      `EmailSubmission/set failed: ${JSON.stringify(subResult)}`
    );
  }

  const created = (emailResult as any).created?.["willow-send"];
  const submitted = (subResult as any).created?.["willow-send-sub"];

  if (!created) {
    const notCreated = (emailResult as any).notCreated;
    throw new Error(`Failed to create email: ${JSON.stringify(notCreated)}`);
  }

  if (!submitted) {
    const notCreated = (subResult as any).notCreated;
    throw new Error(`Failed to submit email: ${JSON.stringify(notCreated)}`);
  }

  return {
    emailId: created.id,
    submissionId: submitted.id,
  };
}

async function getIdentityId(
  session: JMAPSession,
  token: string
): Promise<string> {
  const response = await jmapRequest(
    session.apiUrl,
    token,
    [
      [
        "Identity/get",
        {
          accountId: session.accountId,
          properties: ["id", "name", "email"],
        },
        "i1",
      ],
    ],
    ["urn:ietf:params:jmap:submission"]
  );

  const [, result] = response.methodResponses[0];
  const identities = result.list as {
    id: string;
    name: string;
    email: string;
  }[];

  if (identities.length === 0) {
    throw new Error("No identities found for this account");
  }

  // Use the identity matching willow-notification@vineel.com
  const match = identities.find(
    (i) => i.email === NOTIFICATION_ADDRESS
  );
  return match?.id ?? identities[0].id;
}
