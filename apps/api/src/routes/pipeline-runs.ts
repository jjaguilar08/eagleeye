import type { FastifyInstance } from "fastify";
import type { CreatePipelineRunRequest } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";
import { SearchService, SearchServiceError } from "../services/search.js";
import { crawlerService } from "../services/crawler.js";
import { extractAuthor } from "../services/author-extractor.js";
import { discoverContacts } from "../services/contact-discovery.js";

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
        include: { articles: { select: articleSelect } },
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
      include: { articles: { select: articleSelect } },
    });
  });

  app.get<{ Params: { id: string } }>("/pipeline-runs/:id", async (request, reply) => {
    const run = await prisma.pipelineRun.findUnique({
      where: { id: request.params.id },
      include: { articles: { select: articleSelect } },
    });

    if (!run) {
      return reply.code(404).send({ error: "Pipeline run not found" });
    }

    return run;
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

    const run = await prisma.pipelineRun.findUnique({
      where: { id: request.params.id },
      include: { articles: { select: articleSelect } },
    });

    if (!run) {
      return reply.code(404).send({ error: "Pipeline run not found" });
    }

    const discovered = run.articles.filter((article) => article.status === "DISCOVERED");

    // Sequential, not concurrent — there's no job queue yet (Day 7), and the
    // per-domain rate limiter already serializes same-domain requests
    // anyway, so concurrency would only help articles on different domains
    // at the cost of complexity this day doesn't need.
    for (const article of discovered) {
      const result = await crawlerService.crawlArticle(article.url);

      await prisma.article.update({
        where: { id: article.id },
        data:
          result.status === "CRAWLED"
            ? { status: "CRAWLED", rawHtml: result.rawHtml, crawlError: null }
            : { status: "FAILED", crawlError: result.crawlError },
      });
    }

    const updated = await prisma.pipelineRun.findUnique({
      where: { id: run.id },
      include: { articles: { select: articleSelect } },
    });

    return updated;
  });

  // No automation gate here, unlike /pipeline-runs and .../crawl above:
  // extraction is pure structural parsing over Article.rawHtml already
  // fetched by Day 4's crawl — no external calls, no third-party load, no
  // cost. The automation toggle exists specifically to prevent unattended
  // spend/third-party traffic, neither of which applies to this step.
  app.post<{ Params: { id: string } }>(
    "/pipeline-runs/:id/extract-authors",
    async (request, reply) => {
      const run = await prisma.pipelineRun.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });

      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Fetched separately (not via articleSelect) so rawHtml never ends up
      // on a response object elsewhere in this route — same convention as
      // the crawler route excluding it from every returned Article shape.
      const pending = await prisma.article.findMany({
        where: { pipelineRunId: run.id, status: "CRAWLED", author: null },
        select: { id: true, url: true, rawHtml: true },
      });

      for (const article of pending) {
        // CRAWLED articles always have rawHtml set by the crawler; the ""
        // fallback is just a defensive guard, and would itself simply
        // extract to a NONE result rather than throwing.
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

      const updated = await prisma.pipelineRun.findUnique({
        where: { id: run.id },
        include: { articles: { select: articleSelect } },
      });

      return updated;
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

      const run = await prisma.pipelineRun.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });

      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Idempotency: only authors with no ContactAttempt records yet are
      // eligible — whether discovery has run is queryable via that relation,
      // no new pipeline-stage enum value needed.
      const eligible = await prisma.article.findMany({
        where: { pipelineRunId: run.id, status: "EXTRACTED" },
        select: {
          id: true,
          sourceDomain: true,
          author: { select: { id: true, name: true, profileUrl: true, contactAttempts: true } },
        },
      });

      for (const article of eligible) {
        if (!article.author || article.author.contactAttempts.length > 0) continue;

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

      const updated = await prisma.pipelineRun.findUnique({
        where: { id: run.id },
        include: { articles: { select: articleSelect } },
      });

      return updated;
    },
  );
}

function failRun(runId: string) {
  return prisma.pipelineRun.update({
    where: { id: runId },
    data: { status: "FAILED", completedAt: new Date() },
    include: { articles: { select: articleSelect } },
  });
}
