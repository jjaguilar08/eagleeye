// Placeholder shared type proving the workspace wiring works; real domain types land Day 2+.
export interface HealthStatus {
  status: "ok";
}

// --- Settings ---

export interface SettingDTO {
  id: number;
  automationEnabled: boolean;
  searchTopic: string;
  maxArticlesPerRun: number;
  maxDraftsPerRun: number;
  maxSendsPerRun: number;
  dailySendCap: number;
  // Persona/company fields Day 8's AI draft service renders into generated
  // outreach emails. Fictionalized stand-in company, not the real one this
  // demo project is based on — see notes.md Day 8.
  companyName: string;
  senderName: string;
  senderRole: string;
  productPitch: string;
}

export interface UpdateSettingRequest {
  automationEnabled?: boolean;
  searchTopic?: string;
}

// --- Pipeline runs / articles ---

export type PipelineRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED";
// Which of the four pipeline stages the Day 7 BullMQ worker is currently on.
// Distinct from PipelineRunStatus (overall run health) — null whenever the
// run isn't actively being worked (before start or after a terminal status).
export type PipelineStage = "SEARCHING" | "CRAWLING" | "EXTRACTING" | "DISCOVERING_CONTACTS";
export type ArticleStatus = "DISCOVERED" | "CRAWLED" | "EXTRACTED" | "FAILED";

export type AuthorExtractionMethod =
  "JSON_LD" | "META_TAG" | "BYLINE_PATTERN" | "AUTHOR_BIO_PAGE" | "STAFF_PAGE" | "NONE";

export type ContactAttemptMethod =
  "CONTACT_PAGE_SCAN" | "EMAIL_PATTERN_GUESS" | "OUTLET_FALLBACK" | "MANUAL";
export type ContactAttemptStatus = "FOUND" | "OUTLET_FALLBACK" | "NEEDS_REVIEW" | "FAILED";

export interface ContactAttemptDTO {
  id: string;
  authorId: string;
  method: ContactAttemptMethod;
  emailCandidate: string | null;
  confidence: number;
  status: ContactAttemptStatus;
  createdAt: string;
}

export interface AuthorDTO {
  id: string;
  articleId: string;
  name: string | null;
  extractionMethod: AuthorExtractionMethod;
  confidence: number;
  profileUrl: string | null;
  createdAt: string;
  // Full attempt log, not just the winner — empty until Day 6's contact
  // discovery has run for this author.
  contactAttempts: ContactAttemptDTO[];
}

// --- Email drafting (Day 8) ---

export type EmailThreadStatus = "DRAFT" | "PENDING_APPROVAL" | "SENT" | "REPLIED" | "CLOSED";
export type MessageDirection = "OUTBOUND" | "INBOUND";

export interface MessageDTO {
  id: string;
  threadId: string;
  direction: MessageDirection;
  aiGenerated: boolean;
  approvedByUser: boolean;
  body: string;
  sentAt: string | null;
  createdAt: string;
}

export interface EmailThreadDTO {
  id: string;
  articleId: string;
  authorId: string;
  contactAttemptId: string | null;
  recipientEmail: string;
  subject: string;
  status: EmailThreadStatus;
  createdAt: string;
  updatedAt: string;
  // The one AI-drafted OUTBOUND message, plus any INBOUND replies Day 10's
  // webhook has attached since, ordered chronologically.
  messages: MessageDTO[];
}

export interface UpdateEmailDraftRequest {
  subject: string;
  body: string;
}

// One per Article the draft-emails batch attempted (drafted or failed) —
// articles skipped for already having a thread aren't included here, since
// they already show up via ArticleDTO.emailThreads.
export interface DraftEmailBatchItemDTO {
  articleId: string;
  outcome: "drafted" | "failed";
  reason?: string;
  threadId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DraftEmailsResponse {
  run: PipelineRunDTO;
  results: DraftEmailBatchItemDTO[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface ArticleDTO {
  id: string;
  pipelineRunId: string;
  url: string;
  title: string;
  sourceDomain: string;
  sourceName: string | null;
  publishedAt: string | null;
  status: ArticleStatus;
  // Deliberately omitted here: rawHtml. The dashboard only ever needs
  // status/crawlError to review a crawl — raw HTML isn't rendered anywhere,
  // so it's left off the wire type entirely rather than sent and ignored.
  crawlError: string | null;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
  // Null until extraction has been attempted. Once attempted, this is always
  // set (status becomes EXTRACTED either way) — even when no author was
  // found, extractionMethod: "NONE" records that the attempt happened.
  author: AuthorDTO | null;
  // Empty until Day 8's draft-emails has run for this article. In practice
  // at most one, enforced by the draft-emails route's own idempotency check
  // — kept as an array to match the schema's actual one-to-many relation.
  emailThreads: EmailThreadDTO[];
}

export interface PipelineRunDTO {
  id: string;
  topic: string;
  maxArticles: number;
  maxDrafts: number;
  maxSends: number;
  status: PipelineRunStatus;
  currentStage: PipelineStage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  articles: ArticleDTO[];
  /**
   * Transient failure detail — not persisted on PipelineRun (the schema has
   * no error-message column), only present on the response when status is
   * FAILED.
   */
  error?: string;
}

export interface CreatePipelineRunRequest {
  topic: string;
  maxArticles: number;
}

// --- Whitelist (Day 9) ---

export interface WhitelistEntryDTO {
  id: string;
  email: string;
  label: string | null;
  createdAt: string;
}

export interface CreateWhitelistEntryRequest {
  email: string;
  label?: string;
}
