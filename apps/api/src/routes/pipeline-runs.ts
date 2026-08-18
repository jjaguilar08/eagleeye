import type { FastifyInstance } from "fastify";
import type { CreatePipelineRunRequest } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";
import { enqueuePipelineRun } from "../lib/pipeline-queue.js";
import {
  getRunFailureReason,
  runCrawlStage,
  runExtractStage,
  runDiscoverStage,
} from "../services/pipeline-orchestrator.js";

const contactAttemptSelect = {
  id: true,
  authorId: true,
  method: true,
  emailCandidate: true,
  confidence: true,
  status: true,
  createdAt: true,
} as const;

const authorSelect = {
  id: true,
  articleId: true,
  name: true,
  extractionMethod: true,
  confidence: true,
  profileUrl: true,
  createdAt: true,
  contactAttempts: { select: contactAttemptSelect, orderBy: { createdAt: "asc" } },
} as const;

// Excludes `rawHtml` from every API response — the dashboard only ever
// displays status/crawlError/author fields, and there's no reason to ship
// potentially large HTML blobs over the wire for a value nothing renders.
const articleSelect = {
  id: true,
  pipelineRunId: true,
  url: true,
  title: true,
  sourceDomain: true,
  sourceName: true,
  publishedAt: true,
  status: true,
  crawlError: true,
  discoveredAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: authorSelect },
} as const;

const runSelect = {
  id: true,
  topic: true,
  maxArticles: true,
  maxDrafts: true,
  maxSends: true,
  status: true,
  currentStage: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  articles: { select: articleSelect },
} as const;

type RunRow = Awaited<ReturnType<typeof findRun>>;

function findRun(id: string) {
  return prisma.pipelineRun.findUnique({ where: { id }, select: runSelect });
}

// Attaches the transient `error` field (Day 3's stopgap — see
// pipeline-orchestrator.ts's failureReasons map) whenever a run is FAILED
// and a reason was recorded for it. Automated runs fail inside the Worker,
// with no HTTP request to attach an error to directly, so GET responses are
// where the dashboard actually learns why.
function withError(run: NonNullable<RunRow>) {
  const reason = run.status === "FAILED" ? getRunFailureReason(run.id) : undefined;
  return reason ? { ...run, error: reason } : run;
}

export async function pipelineRunRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreatePipelineRunRequest }>("/pipeline-runs", async (request, reply) => {
    const { topic, maxArticles } = request.body ?? {};

    if (typeof topic !== "string" || topic.trim() === "") {
      return reply.code(400).send({ error: "topic is required" });
    }

    const settings = await prisma.setting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });

    if (!settings.automationEnabled) {
      return reply
        .code(403)
        .send({ error: "Automation is disabled. Enable it in Settings before starting a run." });
    }

    // Server-side clamp — never trust the client's maxArticles, even though
    // the dashboard also caps its input at the same value.
    const requested =
      typeof maxArticles === "number" && Number.isFinite(maxArticles) && maxArticles > 0
        ? Math.floor(maxArticles)
        : settings.maxArticlesPerRun;
    const clampedMaxArticles = Math.min(requested, settings.maxArticlesPerRun);

    const run = await prisma.pipelineRun.create({
      data: {
        topic,
        maxArticles: clampedMaxArticles,
        maxDrafts: settings.maxDraftsPerRun,
        maxSends: settings.maxSendsPerRun,
        status: "PENDING",
      },
      select: runSelect,
    });

    // The actual search/crawl/extract/discover work happens in the Worker
    // (see lib/pipeline-queue.ts + services/pipeline-orchestrator.ts) — this
    // request returns as soon as the job is queued, not once the run finishes.
    await enqueuePipelineRun(run.id);

    return reply.code(201).send(withError(run));
  });

  app.get("/pipeline-runs", async () => {
    const runs = await prisma.pipelineRun.findMany({
      orderBy: { createdAt: "desc" },
      select: runSelect,
    });
    return runs.map(withError);
  });

  app.get<{ Params: { id: string } }>("/pipeline-runs/:id", async (request, reply) => {
    const run = await findRun(request.params.id);

    if (!run) {
      return reply.code(404).send({ error: "Pipeline run not found" });
    }

    return withError(run);
  });

  // Cooperative — sets status STOPPED and lets the Worker's own checks
  // (before each stage, and before each article within a stage's loop) halt
  // the run at the next checkpoint, bounded to roughly one article's
  // processing time. This endpoint does not forcibly kill in-flight work.
  app.post<{ Params: { id: string } }>("/pipeline-runs/:id/stop", async (request, reply) => {
    const run = await findRun(request.params.id);

    if (!run) {
      return reply.code(404).send({ error: "Pipeline run not found" });
    }

    if (run.status === "PENDING" || run.status === "RUNNING") {
      await prisma.pipelineRun.update({ where: { id: run.id }, data: { status: "STOPPED" } });
    }

    const updated = await findRun(run.id);
    return withError(updated!);
  });

  app.post<{ Params: { id: string } }>("/pipeline-runs/:id/crawl", async (request, reply) => {
    const settings = await prisma.setting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });

    if (!settings.automationEnabled) {
      return reply
        .code(403)
        .send({ error: "Automation is disabled. Enable it in Settings before crawling." });
    }

    const run = await findRun(request.params.id);

    if (!run) {
      return reply.code(404).send({ error: "Pipeline run not found" });
    }

    await runCrawlStage(run.id);

    const updated = await findRun(run.id);
    return withError(updated!);
  });

  // No automation gate here, unlike /pipeline-runs and .../crawl above:
  // extraction is pure structural parsing over Article.rawHtml already
  // fetched by Day 4's crawl — no external calls, no third-party load, no
  // cost. The automation toggle exists specifically to prevent unattended
  // spend/third-party traffic, neither of which applies to this step.
  app.post<{ Params: { id: string } }>(
    "/pipeline-runs/:id/extract-authors",
    async (request, reply) => {
      const run = await findRun(request.params.id);

      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      await runExtractStage(run.id);

      const updated = await findRun(run.id);
      return withError(updated!);
    },
  );

  // Same automation gate as .../crawl: contact/author-profile-page scanning
  // means new real HTTP requests to outlet domains, unlike extract-authors
  // (pure local computation over already-stored HTML).
  app.post<{ Params: { id: string } }>(
    "/pipeline-runs/:id/discover-contacts",
    async (request, reply) => {
      const settings = await prisma.setting.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
      });

      if (!settings.automationEnabled) {
        return reply.code(403).send({
          error: "Automation is disabled. Enable it in Settings before discovering contacts.",
        });
      }

      const run = await findRun(request.params.id);

      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      await runDiscoverStage(run.id);

      const updated = await findRun(run.id);
      return withError(updated!);
    },
  );
}
