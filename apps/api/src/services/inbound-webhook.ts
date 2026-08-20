import { Resend } from "resend";
import type { WebhookEventPayload } from "resend";
import * as cheerio from "cheerio";
import { prisma } from "../lib/prisma.js";

// Thrown when the raw body's svix signature doesn't verify against
// RESEND_WEBHOOK_SECRET (or the svix-* headers are missing entirely) — the
// route maps this to 401, before anything in the payload is trusted or
// acted on.
export class SignatureVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignatureVerificationError";
  }
}

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

// Minimal shape of the Resend SDK surface this service actually uses — lets
// unit tests mock both webhook verification and the receiving-email fetch
// entirely (no real network calls in tests/CI), same convention as
// email-sender.ts's ResendEmailsClient.
export interface InboundWebhookResendClient {
  webhooks: {
    verify(payload: {
      payload: string;
      headers: { id: string; timestamp: string; signature: string };
      webhookSecret: string;
    }): WebhookEventPayload;
  };
  emails: {
    receiving: {
      get(id: string): Promise<{
        data: { text: string | null; html: string | null } | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface FindMatchingThreadFn {
  (fromEmail: string): Promise<{ id: string } | null>;
}

export interface AttachInboundMessageFn {
  (input: { threadId: string; body: string; providerEmailId: string }): Promise<void>;
}

export interface IsDuplicateEmailFn {
  (providerEmailId: string): Promise<boolean>;
}

export type InboundWebhookResult =
  // We only ever subscribe to email.received, but the webhook payload shape
  // isn't guaranteed to stay that way forever — ack and ignore rather than
  // assume, per the brief.
  | { outcome: "ignored_event_type" }
  | { outcome: "duplicate" }
  // No EmailThread we sent to matches this sender — deliberately not
  // persisted as an orphan record (out of scope for this pass, see notes.md
  // Day 10's known-limitations entry); the route logs this server-side.
  | { outcome: "no_match"; from: string; to: string[]; subject: string }
  | { outcome: "attached"; threadId: string };

export interface InboundWebhookServiceConfig {
  apiKey: string;
  webhookSecret: string;
  clientImpl?: InboundWebhookResendClient;
  // Test-only overrides — every real construction site (the webhook route)
  // uses the Prisma-backed defaults below.
  isDuplicate?: IsDuplicateEmailFn;
  findMatchingThread?: FindMatchingThreadFn;
  attachInboundMessage?: AttachInboundMessageFn;
}

// A thread only ever becomes eligible for a reply once we've actually sent
// something to it (SENT) or already received one earlier reply (REPLIED) —
// DRAFT/PENDING_APPROVAL never left this system, and CLOSED is a deliberate
// terminal state, so neither should pick up an inbound message.
const REPLYABLE_STATUSES = ["SENT", "REPLIED"] as const;

async function defaultIsDuplicate(providerEmailId: string): Promise<boolean> {
  const existing = await prisma.message.findUnique({ where: { providerEmailId } });
  return existing !== null;
}

// Deliberately simple: matches by recipient address alone, not
// Message-ID/In-Reply-To threading — consistent with this project's running
// preference for simplicity at demo scale (same judgment call as the
// non-AI contact discovery waterfall). Case-insensitive since
// EmailThread.recipientEmail isn't normalized to lowercase the way
// WhitelistEntry.email is.
async function defaultFindMatchingThread(fromEmail: string): Promise<{ id: string } | null> {
  return prisma.emailThread.findFirst({
    where: {
      recipientEmail: { equals: fromEmail, mode: "insensitive" },
      status: { in: [...REPLYABLE_STATUSES] },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
}

async function defaultAttachInboundMessage(input: {
  threadId: string;
  body: string;
  providerEmailId: string;
}): Promise<void> {
  await prisma.$transaction([
    prisma.message.create({
      data: {
        threadId: input.threadId,
        direction: "INBOUND",
        aiGenerated: false,
        approvedByUser: false,
        body: input.body,
        providerEmailId: input.providerEmailId,
      },
    }),
    prisma.emailThread.update({ where: { id: input.threadId }, data: { status: "REPLIED" } }),
  ]);
}

function htmlToText(html: string): string {
  return cheerio.load(html).text().trim();
}

export class InboundWebhookService {
  private readonly client: InboundWebhookResendClient;
  private readonly webhookSecret: string;
  private readonly isDuplicate: IsDuplicateEmailFn;
  private readonly findMatchingThread: FindMatchingThreadFn;
  private readonly attachInboundMessage: AttachInboundMessageFn;

  constructor(config: InboundWebhookServiceConfig) {
    this.client = config.clientImpl ?? new Resend(config.apiKey);
    this.webhookSecret = config.webhookSecret;
    this.isDuplicate = config.isDuplicate ?? defaultIsDuplicate;
    this.findMatchingThread = config.findMatchingThread ?? defaultFindMatchingThread;
    this.attachInboundMessage = config.attachInboundMessage ?? defaultAttachInboundMessage;
  }

  /**
   * Processes one Resend inbound webhook delivery. `rawBody` must be the
   * exact bytes/string Resend sent — svix signature verification is
   * whitespace/key-order sensitive, so a re-serialized JSON.stringify() of
   * the parsed body can fail verification even for a genuine event.
   */
  async handle(rawBody: string, headers: WebhookHeaders): Promise<InboundWebhookResult> {
    if (!headers.id || !headers.timestamp || !headers.signature) {
      throw new SignatureVerificationError(
        "Missing svix-id/svix-timestamp/svix-signature headers.",
      );
    }

    let event: WebhookEventPayload;
    try {
      event = this.client.webhooks.verify({
        payload: rawBody,
        headers: { id: headers.id, timestamp: headers.timestamp, signature: headers.signature },
        webhookSecret: this.webhookSecret,
      });
    } catch (error) {
      throw new SignatureVerificationError("Webhook signature verification failed.", {
        cause: error,
      });
    }

    if (event.type !== "email.received") {
      return { outcome: "ignored_event_type" };
    }

    const { email_id: emailId, from, to, subject } = event.data;

    if (await this.isDuplicate(emailId)) {
      return { outcome: "duplicate" };
    }

    const { data, error } = await this.client.emails.receiving.get(emailId);
    if (error || !data) {
      throw new Error(error?.message ?? "Failed to fetch received email body from Resend.");
    }
    const body = data.text ?? (data.html ? htmlToText(data.html) : "");

    const thread = await this.findMatchingThread(from);
    if (!thread) {
      return { outcome: "no_match", from, to, subject };
    }

    await this.attachInboundMessage({ threadId: thread.id, body, providerEmailId: emailId });
    return { outcome: "attached", threadId: thread.id };
  }
}
