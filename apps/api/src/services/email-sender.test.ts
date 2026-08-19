import { describe, expect, it, vi } from "vitest";
import { EmailSendError, EmailSenderService, WhitelistRejectedError } from "./email-sender.js";
import type { ResendEmailsClient } from "./email-sender.js";

function baseInput() {
  return {
    to: "editor@example-outdoorwire.test",
    from: "alex@timberline.test",
    senderName: "Alex Morgan",
    subject: "Loved your treestand roundup",
    body: "Hi Casey, great piece on treestands...",
  };
}

describe("EmailSenderService.send", () => {
  it("rejects a non-whitelisted recipient before any Resend API call is made", async () => {
    const send = vi.fn();
    const clientImpl: ResendEmailsClient = { emails: { send } };
    const isWhitelisted = vi.fn().mockResolvedValue(false);
    const service = new EmailSenderService({ apiKey: "key", clientImpl, isWhitelisted });

    await expect(service.send(baseInput())).rejects.toBeInstanceOf(WhitelistRejectedError);
    expect(send).not.toHaveBeenCalled();
    expect(isWhitelisted).toHaveBeenCalledWith("editor@example-outdoorwire.test");
  });

  it("checks the whitelist with a lowercased recipient address", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const clientImpl: ResendEmailsClient = { emails: { send } };
    const isWhitelisted = vi.fn().mockResolvedValue(true);
    const service = new EmailSenderService({ apiKey: "key", clientImpl, isWhitelisted });

    await service.send({ ...baseInput(), to: "Editor@Example-OutdoorWire.TEST" });

    expect(isWhitelisted).toHaveBeenCalledWith("editor@example-outdoorwire.test");
  });

  it("sends via the Resend client with a formatted From header when whitelisted", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const clientImpl: ResendEmailsClient = { emails: { send } };
    const isWhitelisted = vi.fn().mockResolvedValue(true);
    const service = new EmailSenderService({ apiKey: "key", clientImpl, isWhitelisted });

    const result = await service.send(baseInput());

    expect(result).toEqual({ messageId: "msg_1" });
    expect(send).toHaveBeenCalledWith({
      from: "Alex Morgan <alex@timberline.test>",
      to: "editor@example-outdoorwire.test",
      subject: "Loved your treestand roundup",
      text: "Hi Casey, great piece on treestands...",
    });
  });

  it("throws EmailSendError when Resend returns an error", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({
        data: null,
        error: { message: "Invalid from address", name: "validation_error" },
      });
    const clientImpl: ResendEmailsClient = { emails: { send } };
    const isWhitelisted = vi.fn().mockResolvedValue(true);
    const service = new EmailSenderService({ apiKey: "key", clientImpl, isWhitelisted });

    await expect(service.send(baseInput())).rejects.toMatchObject({
      name: "EmailSendError",
      message: "Invalid from address",
    });
  });

  it("throws EmailSendError when Resend returns neither data nor an error", async () => {
    const send = vi.fn().mockResolvedValue({ data: null, error: null });
    const clientImpl: ResendEmailsClient = { emails: { send } };
    const isWhitelisted = vi.fn().mockResolvedValue(true);
    const service = new EmailSenderService({ apiKey: "key", clientImpl, isWhitelisted });

    await expect(service.send(baseInput())).rejects.toBeInstanceOf(EmailSendError);
  });
});
