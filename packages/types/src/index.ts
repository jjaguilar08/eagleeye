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
}

export interface UpdateSettingRequest {
  automationEnabled?: boolean;
  searchTopic?: string;
}

// --- Pipeline runs / articles ---

export type PipelineRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED";
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
}

export interface PipelineRunDTO {
  id: string;
  topic: string;
  maxArticles: number;
  maxDrafts: number;
  maxSends: number;
  status: PipelineRunStatus;
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
