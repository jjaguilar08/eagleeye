import Anthropic from "@anthropic-ai/sdk";

// claude-haiku-4-5-20251001 — small/cheap enough for a ~150-word outreach
// draft, per the Day 8 brief.
const MODEL_ID = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 800;

// Point-in-time Claude Haiku 4.5 pricing, $ per million tokens, confirmed
// against Anthropic's docs on 2026-08-19. Same "don't trust stale assumptions
// about external pricing" lesson as Day 3's search-provider saga — re-verify
// this against https://www.anthropic.com/pricing before trusting it for real
// billing decisions later in the project's life.
export const HAIKU_INPUT_PRICE_PER_MILLION_USD = 1.0;
export const HAIKU_OUTPUT_PRICE_PER_MILLION_USD = 5.0;

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * HAIKU_INPUT_PRICE_PER_MILLION_USD +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE_PER_MILLION_USD
  );
}

export interface DraftEmailArticle {
  title: string;
  url: string;
  sourceName: string | null;
  sourceDomain: string;
}

export interface DraftEmailPersona {
  companyName: string;
  senderName: string;
  senderRole: string;
  productPitch: string;
}

export interface DraftEmailInput {
  article: DraftEmailArticle;
  // Null when Day 5's extraction found no author name — falls back to a
  // generic greeting rather than blocking drafting entirely.
  authorName: string | null;
  persona: DraftEmailPersona;
}

export interface DraftEmailResult {
  subject: string;
  body: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Thrown after a parse failure survives one retry — carries the token usage
// from both attempts so the caller can still account for the spend (billing
// happens regardless of parse outcome, per the brief).
export class EmailDraftError extends Error {
  readonly inputTokens: number;
  readonly outputTokens: number;

  constructor(message: string, inputTokens: number, outputTokens: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmailDraftError";
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }
}

// Minimal shape of the Anthropic SDK surface this service actually uses —
// lets unit tests mock the client entirely (no real API calls/tokens spent
// in tests/CI) without depending on the full @anthropic-ai/sdk types.
export interface AnthropicMessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user"; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

function buildSystemPrompt(persona: DraftEmailPersona, strict: boolean): string {
  const base = `You are ${persona.senderName}, ${persona.senderRole} at ${persona.companyName}. ${persona.companyName} sells ${persona.productPitch}.

Draft a short (about 150 words), professional, non-spammy outreach email to a journalist or author, pitching a possible product feature or mention. Explicitly reference the specific article you were given (by its title or subject) to show you actually read it and this isn't a form letter — genuine relevance, not generic flattery. Sign off as ${persona.senderName}, ${persona.senderRole} at ${persona.companyName}.

Respond with exactly this format and nothing else — no preamble, no markdown, no commentary:
<subject>the email subject line</subject><body>the full email body</body>`;

  if (!strict) return base;

  return `${base}

Your previous response did not follow this format. This time, respond with ONLY the <subject>...</subject><body>...</body> tags — no text before, after, or outside them.`;
}

function buildUserPrompt(input: DraftEmailInput): string {
  const greeting = input.authorName ?? "there";
  const publication = input.article.sourceName ?? input.article.sourceDomain;
  return `Recipient: ${greeting}
Publication: ${publication}
Article title: ${input.article.title}
Article URL: ${input.article.url}`;
}

function parseDraftResponse(text: string): { subject: string; body: string } | null {
  const subjectMatch = text.match(/<subject>([\s\S]*?)<\/subject>/i);
  const bodyMatch = text.match(/<body>([\s\S]*?)<\/body>/i);
  const subject = subjectMatch?.[1]?.trim();
  const body = bodyMatch?.[1]?.trim();
  if (!subject || !body) return null;
  return { subject, body };
}

export interface EmailDraftServiceConfig {
  apiKey: string;
  clientImpl?: AnthropicMessagesClient;
}

export class EmailDraftService {
  private readonly client: AnthropicMessagesClient;

  constructor(config: EmailDraftServiceConfig) {
    this.client = config.clientImpl ?? new Anthropic({ apiKey: config.apiKey });
  }

  /**
   * Drafts one outreach email. Asks for `<subject>/<body>`-wrapped output so
   * the response can be reliably parsed; retries once with a stricter
   * instruction on parse failure, then throws `EmailDraftError` rather than
   * looping further — the caller treats that as one failed article and moves
   * on to the next, same per-item-failure pattern as crawling/contact
   * discovery.
   */
  async draftEmail(input: DraftEmailInput): Promise<DraftEmailResult> {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.client.messages.create({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(input.persona, attempt > 0),
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      });

      // Captured for every call, successful or not — billing happens
      // regardless of parse outcome.
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      const text = response.content.find((block) => block.type === "text")?.text ?? "";
      const parsed = parseDraftResponse(text);
      if (parsed) {
        return {
          ...parsed,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: estimateCostUsd(totalInputTokens, totalOutputTokens),
        };
      }
    }

    throw new EmailDraftError(
      "Could not parse a structured draft from the model's response, even after a retry.",
      totalInputTokens,
      totalOutputTokens,
    );
  }
}
