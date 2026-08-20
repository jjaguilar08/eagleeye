import { describe, expect, it, vi } from "vitest";
import type { WebhookEventPayload } from "resend";
import {
  InboundWebhookService,
  SignatureVerificationError,
  type InboundWebhookResendClient,
} from "./inbound-webhook.js";

function baseHeaders() {
  return { id: "msg_1", timestamp: "1700000000", signature: "v1,abc123" };
}

function receivedEvent(overrides: Partial<WebhookEventPayload & { type: "email.received" }> = {}) {
  return {
    type: "email.received" as const,
    created_at: "2026-08-20T00:00:00Z",
    data: {
      email_id: "email_123",
      created_at: "2026-08-20T00:00:00Z",
      from: "editor@example-outdoorwire.test",
      to: ["alex@eagleeye.jjaguilar.dev"],
      bcc: [],
      cc: [],
      received_for: ["alex@eagleeye.jjaguilar.dev"],
      message_id: "<msg@example-outdoorwire.test>",
      subject: "Re: Timberline Gear Feature",
      attachments: [],
    },
    ...overrides,
  } as WebhookEventPayload;
}

function makeClient(
  overrides: Partial<InboundWebhookResendClient> = {},
): InboundWebhookResendClient {
  return {
    webhooks: { verify: vi.fn().mockReturnValue(receivedEvent()) },
    emails: {
      receiving: {
        get: vi
          .fn()
          .mockResolvedValue({ data: { text: "Thanks, let's talk.", html: null }, error: null }),
      },
    },
    ...overrides,
  };
}

describe("InboundWebhookService.handle", () => {
  it("rejects when the svix headers are missing entirely", async () => {
    const clientImpl = makeClient();
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
    });

    await expect(
      service.handle("{}", { id: undefined, timestamp: undefined, signature: undefined }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
    expect(clientImpl.webhooks.verify).not.toHaveBeenCalled();
  });

  it("rejects when signature verification throws", async () => {
    const verify = vi.fn().mockImplementation(() => {
      throw new Error("svix: invalid signature");
    });
    const clientImpl = makeClient({ webhooks: { verify } });
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
    });

    await expect(service.handle("{}", baseHeaders())).rejects.toBeInstanceOf(
      SignatureVerificationError,
    );
  });

  it("passes the raw body and secret straight through to webhooks.verify", async () => {
    const clientImpl = makeClient();
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "whsec_test",
      clientImpl,
      isDuplicate: vi.fn().mockResolvedValue(false),
      findMatchingThread: vi.fn().mockResolvedValue(null),
    });

    await service.handle('{"raw":"body"}', baseHeaders());

    expect(clientImpl.webhooks.verify).toHaveBeenCalledWith({
      payload: '{"raw":"body"}',
      headers: baseHeaders(),
      webhookSecret: "whsec_test",
    });
  });

  it("acks and ignores event types other than email.received", async () => {
    const clientImpl = makeClient({
      webhooks: {
        verify: vi.fn().mockReturnValue({ type: "email.sent", created_at: "", data: {} }),
      },
    });
    const isDuplicate = vi.fn();
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
      isDuplicate,
    });

    const result = await service.handle("{}", baseHeaders());

    expect(result).toEqual({ outcome: "ignored_event_type" });
    expect(isDuplicate).not.toHaveBeenCalled();
    expect(clientImpl.emails.receiving.get).not.toHaveBeenCalled();
  });

  it("dedupes on providerEmailId — a replayed event is a no-op and never re-fetches the body", async () => {
    const clientImpl = makeClient();
    const isDuplicate = vi.fn().mockResolvedValue(true);
    const attachInboundMessage = vi.fn();
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
      isDuplicate,
      attachInboundMessage,
    });

    const result = await service.handle("{}", baseHeaders());

    expect(result).toEqual({ outcome: "duplicate" });
    expect(isDuplicate).toHaveBeenCalledWith("email_123");
    expect(clientImpl.emails.receiving.get).not.toHaveBeenCalled();
    expect(attachInboundMessage).not.toHaveBeenCalled();
  });

  it("attaches the reply to the matching thread and marks it REPLIED", async () => {
    const clientImpl = makeClient();
    const findMatchingThread = vi.fn().mockResolvedValue({ id: "thread_1" });
    const attachInboundMessage = vi.fn().mockResolvedValue(undefined);
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
      isDuplicate: vi.fn().mockResolvedValue(false),
      findMatchingThread,
      attachInboundMessage,
    });

    const result = await service.handle("{}", baseHeaders());

    expect(result).toEqual({ outcome: "attached", threadId: "thread_1" });
    expect(findMatchingThread).toHaveBeenCalledWith("editor@example-outdoorwire.test");
    expect(attachInboundMessage).toHaveBeenCalledWith({
      threadId: "thread_1",
      body: "Thanks, let's talk.",
      providerEmailId: "email_123",
    });
  });

  it("falls back to a stripped-text version of the html body when text is null", async () => {
    const clientImpl = makeClient({
      emails: {
        receiving: {
          get: vi
            .fn()
            .mockResolvedValue({
              data: { text: null, html: "<p>Hi <b>there</b></p>" },
              error: null,
            }),
        },
      },
    });
    const attachInboundMessage = vi.fn().mockResolvedValue(undefined);
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
      isDuplicate: vi.fn().mockResolvedValue(false),
      findMatchingThread: vi.fn().mockResolvedValue({ id: "thread_1" }),
      attachInboundMessage,
    });

    await service.handle("{}", baseHeaders());

    expect(attachInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hi there" }),
    );
  });

  it("reports no_match (and does not crash) for a reply from an unrecognized address, without attaching anything", async () => {
    const clientImpl = makeClient();
    const attachInboundMessage = vi.fn();
    const service = new InboundWebhookService({
      apiKey: "key",
      webhookSecret: "secret",
      clientImpl,
      isDuplicate: vi.fn().mockResolvedValue(false),
      findMatchingThread: vi.fn().mockResolvedValue(null),
      attachInboundMessage,
    });

    const result = await service.handle("{}", baseHeaders());

    expect(result).toEqual({
      outcome: "no_match",
      from: "editor@example-outdoorwire.test",
      to: ["alex@eagleeye.jjaguilar.dev"],
      subject: "Re: Timberline Gear Feature",
    });
    expect(attachInboundMessage).not.toHaveBeenCalled();
  });
});
