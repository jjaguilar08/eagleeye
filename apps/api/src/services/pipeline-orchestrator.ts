import type { PipelineRunStatus } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";
import { SearchService, SearchServiceError } from "./search.js";
import { crawlerService } from "./crawler.js";
import { extractAuthor } from "./author-extractor.js";
import { discoverContacts } from "./contact-discovery.js";

export type PipelineStage = "SEARCHING" | "CRAWLING" | "EXTRACTING" | "DISCOVERING_CONTACTS";

export class StageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StageError";
  }
}

// PipelineRun.status FAILED has no persisted message column (see Day 3's
// "transient error field" stopgap, documented on PipelineRunDTO.error) — a
// run that fails mid-pipeline in the Worker has no HTTP request to attach a
// message to, so the reason is kept here instead, keyed by runId, for the
// GET routes to surface on the next poll. Deliberately not persisted: lost
// on server restart, same "stopgap" status as before.
const failureReasons = new Map<string, string>();

export function getRunFailureReason(runId: string): string | undefined {
  return failureReasons.get(runId);
}

async function isRunStopped(runId: string): Promise<boolean> {
  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  return run?.status === "STOPPED";
}

// --- Stage implementations, shared by the manual per-stage routes and the
// automated orchestrator below. Each queries what it needs directly rather
// than trusting a caller-supplied article list, so both callers get
// identical behavior. ---

export async function runSearchStage(runId: string): Promise<void> {
  const run = await prisma.pipelineRun.findUniqueOrThrow({
    where: { id: runId },
    select: { topic: true, maxArticles: true },
  });

  const apiKey = process.env["NEWSAPI_KEY"];
  if (!apiKey) {
    throw new StageError("Search is not configured: missing NEWSAPI_KEY.");
  }

  const searchService = new SearchService({ apiKey });

  let candidates;
  try {
    candidates = await searchService.searchArticles(run.topic, run.maxArticles);
  } catch (error) {
    throw new StageError(
      error instanceof SearchServiceError ? error.message : "Search failed unexpectedly.",
      { cause: error },
    );
  }

  if (candidates.length > 0) {
    await prisma.article.createMany({
      data: candidates.map((candidate) => ({
        pipelineRunId: runId,
        url: candidate.url,
        title: candidate.title,
        sourceDomain: candidate.sourceDomain,
        sourceName: candidate.sourceName,
        publishedAt: candidate.publishedAt ? new Date(candidate.publishedAt) : null,
        status: "DISCOVERED" as const,
        discoveredAt: new Date(),
      })),
      // Article.url is globally unique — a URL discovered by an earlier run
      // stays attached to that run rather than being duplicated here.
      skipDuplicates: true,
    });
  }
}

export async function runCrawlStage(runId: string): Promise<void> {
  const discovered = await prisma.article.findMany({
    where: { pipelineRunId: runId, status: "DISCOVERED" },
    select: { id: true, url: true },
  });

  for (const article of discovered) {
    // Cooperative cancellation: checked before each article, not just once
    // per stage — bounds a Stop request to roughly one article's processing
    // time rather than the rest of the stage.
    if (await isRunStopped(runId)) return;

    const result = await crawlerService.crawlArticle(article.url);

    await prisma.article.update({
      where: { id: article.id },
      data:
        result.status === "CRAWLED"
          ? { status: "CRAWLED", rawHtml: result.rawHtml, crawlError: null }
          : { status: "FAILED", crawlError: result.crawlError },
    });
  }
}

export async function runExtractStage(runId: string): Promise<void> {
  const pending = await prisma.article.findMany({
    where: { pipelineRunId: runId, status: "CRAWLED", author: null },
    select: { id: true, url: true, rawHtml: true },
  });

  for (const article of pending) {
    if (await isRunStopped(runId)) return;

    // CRAWLED articles always have rawHtml set by the crawler; the ""
    // fallback is just a defensive guard, and would itself simply extract
    // to a NONE result rather than throwing.
    const extraction = extractAuthor(article.rawHtml ?? "", article.url);

    await prisma.author.create({
      data: {
        articleId: article.id,
        name: extraction.name,
        extractionMethod: extraction.method,
        confidence: extraction.confidence,
        profileUrl: extraction.profileUrl,
      },
    });

    await prisma.article.update({ where: { id: article.id }, data: { status: "EXTRACTED" } });
  }
}

export async function runDiscoverStage(runId: string): Promise<void> {
  // Idempotency: only authors with no ContactAttempt records yet are
  // eligible — whether discovery has run is queryable via that relation, no
  // new pipeline-stage enum value needed.
  const eligible = await prisma.article.findMany({
    where: { pipelineRunId: runId, status: "EXTRACTED" },
    select: {
      id: true,
      sourceDomain: true,
      author: { select: { id: true, name: true, profileUrl: true, contactAttempts: true } },
    },
  });

  for (const article of eligible) {
    if (!article.author || article.author.contactAttempts.length > 0) continue;
    if (await isRunStopped(runId)) return;

    const results = await discoverContacts(
      { name: article.author.name, profileUrl: article.author.profileUrl },
      article.sourceDomain,
      (url) => crawlerService.fetchPage(url),
    );

    for (const result of results) {
      await prisma.contactAttempt.create({
        data: {
          authorId: article.author.id,
          method: result.method,
          emailCandidate: result.emailCandidate,
          confidence: result.confidence,
          status: result.status,
        },
      });
    }
  }
}

// --- Orchestration ---

interface StageDefinition {
  stage: PipelineStage;
  // SEARCHING is already gated at run-creation time (POST /pipeline-runs
  // rejects when automation is off before a run ever exists); EXTRACTING has
  // no gate per Day 5's reasoning (pure local computation over already-
  // fetched HTML, no external calls). Only the two stages that make new
  // outbound HTTP requests re-check automation mid-run.
  gated: boolean;
  run: (runId: string) => Promise<void>;
}

export interface PipelineOrchestratorDeps {
  stages: StageDefinition[];
  isAutomationEnabled: () => Promise<boolean>;
  getRunStatus: (runId: string) => Promise<PipelineRunStatus>;
  markRunning: (runId: string) => Promise<void>;
  setStage: (runId: string, stage: PipelineStage | null) => Promise<void>;
  markCompleted: (runId: string) => Promise<void>;
  markFailed: (runId: string, reason: string) => Promise<void>;
}

async function isAutomationEnabled(): Promise<boolean> {
  const settings = await prisma.setting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  return settings.automationEnabled;
}

async function getRunStatus(runId: string): Promise<PipelineRunStatus> {
  const run = await prisma.pipelineRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
  });
  return run.status;
}

async function markRunning(runId: string): Promise<void> {
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "RUNNING", startedAt: new Date() },
  });
}

async function setStage(runId: string, stage: PipelineStage | null): Promise<void> {
  await prisma.pipelineRun.update({ where: { id: runId }, data: { currentStage: stage } });
}

async function markCompleted(runId: string): Promise<void> {
  failureReasons.delete(runId);
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "COMPLETED", currentStage: null, completedAt: new Date() },
  });
}

async function markFailed(runId: string, reason: string): Promise<void> {
  failureReasons.set(runId, reason);
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "FAILED", currentStage: null, completedAt: new Date() },
  });
}

export const defaultOrchestratorDeps: PipelineOrchestratorDeps = {
  stages: [
    { stage: "SEARCHING", gated: false, run: runSearchStage },
    { stage: "CRAWLING", gated: true, run: runCrawlStage },
    { stage: "EXTRACTING", gated: false, run: runExtractStage },
    { stage: "DISCOVERING_CONTACTS", gated: true, run: runDiscoverStage },
  ],
  isAutomationEnabled,
  getRunStatus,
  markRunning,
  setStage,
  markCompleted,
  markFailed,
};

/**
 * Runs all four pipeline stages in sequence for one PipelineRun. Called by
 * the BullMQ worker (see queue/pipeline-queue.ts) — this function itself has
 * no BullMQ/Redis dependency, so it's directly unit-testable with a fake
 * `deps`. Cooperative cancellation (STOPPED) is checked before each stage
 * here, and additionally before each article inside a stage's own loop (see
 * the stage implementations above) — bounded to roughly one article's
 * processing time, not instant preemption.
 */
export async function runPipeline(
  runId: string,
  deps: PipelineOrchestratorDeps = defaultOrchestratorDeps,
): Promise<void> {
  // A run can be stopped while still queued, before the worker ever picks
  // it up — honor that rather than starting anyway.
  if ((await deps.getRunStatus(runId)) === "STOPPED") return;

  await deps.markRunning(runId);

  for (const { stage, gated, run } of deps.stages) {
    if ((await deps.getRunStatus(runId)) === "STOPPED") {
      await deps.setStage(runId, null);
      return;
    }

    if (gated && !(await deps.isAutomationEnabled())) {
      await deps.markFailed(runId, "Automation disabled mid-run.");
      return;
    }

    await deps.setStage(runId, stage);

    try {
      await run(runId);
    } catch (error) {
      await deps.markFailed(
        runId,
        error instanceof StageError ? error.message : "Pipeline run failed unexpectedly.",
      );
      return;
    }
  }

  if ((await deps.getRunStatus(runId)) === "STOPPED") {
    await deps.setStage(runId, null);
    return;
  }

  await deps.markCompleted(runId);
}
