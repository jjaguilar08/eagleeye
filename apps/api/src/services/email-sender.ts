import { Resend } from "resend";
import { prisma } from "../lib/prisma.js";

export interface SendEmailInput {
  to: string;
  from: string;
  senderName: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  messageId: string;
}

// This is the single most consequential action in the app — it actually
// delivers an email to a real inbox. Thrown from inside `send()` itself,
// before any Resend API call, so a non-whitelisted recipient can never
// reach the network regardless of what checks (if any) a caller already ran.
export class WhitelistRejectedError extends Error {
  constructor(email: string) {
    super(`${email} is not on the whitelist. Add it in Settings before sending.`);
    this.name = "WhitelistRejectedError";
  }
}

export class EmailSendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmailSendError";
  }
}

// Minimal shape of the Resend SDK surface this service actually uses — lets
// unit tests mock the client entirely (no real emails sent in tests/CI).
// Resend's `emails.send` never throws; it returns { data, error } instead.
export interface ResendEmailsClient {
  emails: {
    send(params: { from: string; to: string; subject: string; text: string }): Promise<{
      data: { id: string } | null;
      error: { message: string; name: string } | null;
    }>;
  };
}

export interface WhitelistCheckFn {
  (email: string): Promise<boolean>;
}

// The real default — queries WhitelistEntry directly. Emails are compared
// lowercased on both sides (the /whitelist POST route normalizes to
// lowercase on insert too) so a casing mismatch can't silently block a real
// send or, worse, let a near-miss through.
async function defaultIsWhitelisted(email: string): Promise<boolean> {
  const entry = await prisma.whitelistEntry.findUnique({
    where: { email: email.toLowerCase() },
  });
  return entry !== null;
}

export interface EmailSenderServiceConfig {
  apiKey: string;
  clientImpl?: ResendEmailsClient;
  // Test-only override — every real construction site (the send route) uses
  // the default, so the whitelist check can't be forgotten by a future
  // caller of this service, only deliberately swapped out by a test.
  isWhitelisted?: WhitelistCheckFn;
}

export class EmailSenderService {
  private readonly client: ResendEmailsClient;
  private readonly isWhitelisted: WhitelistCheckFn;

  constructor(config: EmailSenderServiceConfig) {
    this.client = config.clientImpl ?? new Resend(config.apiKey);
    this.isWhitelisted = config.isWhitelisted ?? defaultIsWhitelisted;
  }

  /**
   * Sends one outreach email via Resend. The whitelist check happens here,
   * inside the lowest-level send function, before any Resend API call —
   * this is deliberately the enforcement point, not the route (which
   * re-checks too, as belt-and-suspenders on top of this, not instead of it).
   */
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!(await this.isWhitelisted(input.to.toLowerCase()))) {
      throw new WhitelistRejectedError(input.to);
    }

    const { data, error } = await this.client.emails.send({
      from: `${input.senderName} <${input.from}>`,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });

    if (error || !data) {
      throw new EmailSendError(error?.message ?? "Resend returned no message id.");
    }

    return { messageId: data.id };
  }
}
