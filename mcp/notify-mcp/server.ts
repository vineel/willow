#!/usr/bin/env bun
/**
 * MCP server for sending notifications and emails via JMAP.
 * Used both by interactive Claude Code sessions and by
 * claude -p during interest action execution.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getSecret } from "../../pib/config";
import { getSession, getMailboxes } from "../../pib/jmap/session";
import { sendNotification, sendEmail } from "../../pib/jmap/notify";
import type { JMAPSession } from "../../pib/jmap/types";

// Cache session + drafts ID across calls
let cachedSession: JMAPSession | null = null;
let cachedDraftsId: string | null = null;
let cachedToken: string | null = null;

async function ensureSession() {
  if (cachedSession && cachedDraftsId && cachedToken) {
    return { session: cachedSession, draftsId: cachedDraftsId, token: cachedToken };
  }
  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);
  const drafts = mailboxes.find((m) => m.role === "drafts");
  if (!drafts) throw new Error("Drafts mailbox not found");
  cachedSession = session;
  cachedDraftsId = drafts.id;
  cachedToken = token;
  return { session, draftsId: drafts.id, token };
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text);
}

function resolveBody(bodyText: string, bodyHtml?: string): { bodyText: string; bodyHtml?: string } {
  if (bodyHtml) return { bodyText, bodyHtml };
  if (isHtml(bodyText)) return { bodyText: stripHtml(bodyText), bodyHtml: bodyText };
  return { bodyText };
}

const server = new McpServer(
  { name: "willow-notify", version: "0.1.0" },
  {
    instructions: [
      "Use send_notification to send messages to Vineel's 'willow' folder in Fastmail.",
      "Use send_email to send emails to other people on Vineel's behalf.",
      "LLMs sometimes put HTML in body_text — the server auto-detects this and handles it.",
      "Subject lines for notifications should start with 'Willow: ' for consistency.",
    ].join(" "),
  }
);

server.tool(
  "send_notification",
  "Send a notification email to the user (Vineel) via Willow's notification system. The email arrives in the 'willow' folder in Fastmail. Use this to notify about interest matches, discoveries, or any proactive information.",
  {
    subject: z.string().describe("Email subject line. Should start with 'Willow: ' for consistency."),
    body_text: z.string().describe("Plain text body of the notification."),
    body_html: z.string().optional().describe("Optional HTML body for rich formatting."),
  },
  async ({ subject, body_text, body_html }) => {
    const { session, draftsId, token } = await ensureSession();
    const body = resolveBody(body_text, body_html);
    const result = await sendNotification(session, token, draftsId, {
      subject,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
    });
    return {
      content: [{
        type: "text",
        text: `Notification sent successfully. Email ID: ${result.emailId}`,
      }],
    };
  }
);

server.tool(
  "send_email",
  "Send an email to a specific recipient on behalf of Vineel. Use this when Willow needs to email someone else (e.g., 'email Stephanie about the concert').",
  {
    to_email: z.string().describe("Recipient email address"),
    to_name: z.string().optional().describe("Recipient name"),
    subject: z.string().describe("Email subject line"),
    body_text: z.string().describe("Plain text body"),
    body_html: z.string().optional().describe("Optional HTML body"),
  },
  async ({ to_email, to_name, subject, body_text, body_html }) => {
    const { session, draftsId, token } = await ensureSession();
    const body = resolveBody(body_text, body_html);
    const result = await sendEmail(session, token, draftsId, {
      to: [{ name: to_name, email: to_email }],
      subject,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
    });
    return {
      content: [{
        type: "text",
        text: `Email sent to ${to_email}. Email ID: ${result.emailId}`,
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
