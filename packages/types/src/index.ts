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

export interface ArticleDTO {
  id: string;
  pipelineRunId: string;
  url: string;
  title: string;
  sourceDomain: string;
  sourceName: string | null;
  publishedAt: string | null;
  status: ArticleStatus;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
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
