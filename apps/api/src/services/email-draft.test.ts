import { describe, expect, it, vi } from "vitest";
import { EmailDraftError, EmailDraftService, estimateCostUsd } from "./email-draft.js";
import type { AnthropicMessagesClient, DraftEmailInput } from "./email-draft.js";

const persona = {
  companyName: "Timberline Outdoor Co.",
  senderName: "Alex Morgan",
  senderRole: "Partnerships Lead",
  productPitch: "outdoor, hunting, and shooting-sports gear",
};

const article = {
  title: "The Best Treestands of 2026, Tested",
  url: "https://example-outdoorwire.test/articles/best-treestands-2026",
  sourceName: "Outdoor Wire",
  sourceDomain: "example-outdoorwire.test",
};

function baseInput(): DraftEmailInput {
  return { article, authorName: "Casey Marsh", persona };
}

function textResponse(text: string, inputTokens = 100, outputTokens = 200) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe("EmailDraftService.draftEmail", () => {
  it("parses a well-formed <subject>/<body> response on the first attempt", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        textResponse(
          "<subject>Loved your treestand roundup</subject><body>Hi Casey, great piece on treestands...</body>",
        ),
      );
    const clientImpl: AnthropicMessagesClient = { messages: { create } };
    const service = new EmailDraftService({ apiKey: "key", clientImpl });

    const result = await service.draftEmail(baseInput());

    expect(result.subject).toBe("Loved your treestand roundup");
    expect(result.body).toBe("Hi Casey, great piece on treestands...");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(200);
    expect(result.costUsd).toBeCloseTo(estimateCostUsd(100, 200));
    expect(create).toHaveBeenCalledTimes(1);

    const params = create.mock.calls[0]![0];
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.system).toContain("Alex Morgan");
    expect(params.system).toContain("Timberline Outdoor Co.");
    expect(params.system).toContain("outdoor, hunting, and shooting-sports gear");
    expect(params.messages[0].content).toContain("The Best Treestands of 2026, Tested");
    expect(params.messages[0].content).toContain("Casey Marsh");
  });

  it("falls back to a generic greeting when authorName is null", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(textResponse("<subject>Hi</subject><body>Hello there...</body>"));
    const clientImpl: AnthropicMessagesClient = { messages: { create } };
    const service = new EmailDraftService({ apiKey: "key", clientImpl });

    await service.draftEmail({ ...baseInput(), authorName: null });

    const params = create.mock.calls[0]![0];
    expect(params.messages[0].content).toContain("Recipient: there");
  });

  it("retries once with a stricter instruction when the first response fails to parse", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(textResponse("Sure, here's a draft: no tags at all here."))
      .mockResolvedValueOnce(
        textResponse("<subject>Second try</subject><body>Now with tags.</body>", 50, 75),
      );
    const clientImpl: AnthropicMessagesClient = { messages: { create } };
    const service = new EmailDraftService({ apiKey: "key", clientImpl });

    const result = await service.draftEmail(baseInput());

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.subject).toBe("Second try");
    // Tokens accumulate across both attempts — billing happens regardless of
    // parse outcome.
    expect(result.inputTokens).toBe(150);
    expect(result.outputTokens).toBe(275);
    const secondCallSystem = create.mock.calls[1]![0].system as string;
    expect(secondCallSystem).toContain("did not follow this format");
  });

  it("throws EmailDraftError carrying accumulated token usage when both attempts fail to parse", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(textResponse("no tags", 10, 20))
      .mockResolvedValueOnce(textResponse("still no tags", 15, 25));
    const clientImpl: AnthropicMessagesClient = { messages: { create } };
    const service = new EmailDraftService({ apiKey: "key", clientImpl });

    await expect(service.draftEmail(baseInput())).rejects.toMatchObject({
      name: "EmailDraftError",
      inputTokens: 25,
      outputTokens: 45,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("treats an empty subject or body as a parse failure", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(textResponse("<subject></subject><body>Body only.</body>", 5, 5))
      .mockResolvedValueOnce(textResponse("<subject>Ok</subject><body>Fixed.</body>", 5, 5));
    const clientImpl: AnthropicMessagesClient = { messages: { create } };
    const service = new EmailDraftService({ apiKey: "key", clientImpl });

    const result = await service.draftEmail(baseInput());
    expect(result.subject).toBe("Ok");
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("estimateCostUsd", () => {
  it("computes $ cost from Haiku's per-million-token pricing", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000)).toBeCloseTo(1.0 + 5.0);
    expect(estimateCostUsd(0, 0)).toBe(0);
  });
});

describe("EmailDraftError", () => {
  it("is a real Error with the expected name and message", () => {
    const error = new EmailDraftError("boom", 1, 2);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EmailDraftError");
    expect(error.message).toBe("boom");
  });
});
