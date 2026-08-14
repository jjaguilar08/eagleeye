import type { FastifyInstance } from "fastify";
import type { CreatePipelineRunRequest } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";
import { SearchService, SearchServiceError } from "../services/search.js";

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
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    const apiKey = process.env["NEWSAPI_KEY"];

    if (!apiKey) {
      const failed = await failRun(run.id);
      return reply.code(201).send({
        ...failed,
        error: "Search is not configured: missing NEWSAPI_KEY.",
      });
    }

    const searchService = new SearchService({ apiKey });

    try {
      const candidates = await searchService.searchArticles(topic, clampedMaxArticles);

      if (candidates.length > 0) {
        await prisma.article.createMany({
          data: candidates.map((candidate) => ({
            pipelineRunId: run.id,
            url: candidate.url,
            title: candidate.title,
            sourceDomain: candidate.sourceDomain,
            sourceName: candidate.sourceName,
            publishedAt: candidate.publishedAt ? new Date(candidate.publishedAt) : null,
            status: "DISCOVERED" as const,
            discoveredAt: new Date(),
          })),
          // Article.url is globally unique — a URL discovered by an earlier
          // run stays attached to that run rather than being duplicated here.
          skipDuplicates: true,
        });
      }

      const completed = await prisma.pipelineRun.update({
        where: { id: run.id },
        data: { status: "COMPLETED", completedAt: new Date() },
        include: { articles: true },
      });

      return reply.code(201).send(completed);
    } catch (error) {
      const message =
        error instanceof SearchServiceError ? error.message : "Search failed unexpectedly.";
      const failed = await failRun(run.id);
      return reply.code(201).send({ ...failed, error: message });
    }
  });

  app.get("/pipeline-runs", async () => {
    return prisma.pipelineRun.findMany({
      orderBy: { createdAt: "desc" },
      include: { articles: true },
    });
  });

  app.get<{ Params: { id: string } }>("/pipeline-runs/:id", async (request, reply) => {
    const run = await prisma.pipelineRun.findUnique({
      where: { id: request.params.id },
      include: { articles: true },
    });

    if (!run) {
      return reply.code(404).send({ error: "Pipeline run not found" });
    }

    return run;
  });
}

function failRun(runId: string) {
  return prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "FAILED", completedAt: new Date() },
    include: { articles: true },
  });
}
