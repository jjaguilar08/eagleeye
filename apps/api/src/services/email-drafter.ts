import { prisma } from "../lib/prisma.js";
import { EmailDraftError, EmailDraftService, estimateCostUsd } from "./email-draft.js";

// Same fixed priority as apps/web's bestContactAttempt (Day 6) — FOUND wins
// over a later-running but lower-quality method, not "most recent". Kept as
// its own small copy here rather than shared through @eagleeye/types: this
// is a one-line business rule over a DTO shape, the same call the dashboard
// already made keeping its own display-side copy rather than importing an
// api service.
const CONTACT_STATUS_PRIORITY = ["FOUND", "OUTLET_FALLBACK", "NEEDS_REVIEW", "FAILED"] as const;

interface ContactAttemptLike {
  id: string;
  status: (typeof CONTACT_STATUS_PRIORITY)[number];
  emailCandidate: string | null;
}

function bestContactAttempt<T extends ContactAttemptLike>(attempts: T[]): T | null {
  for (const status of CONTACT_STATUS_PRIORITY) {
    const match = attempts.find((attempt) => attempt.status === status);
    if (match) return match;
  }
  return null;
}

export interface DraftBatchItemResult {
  articleId: string;
  outcome: "drafted" | "failed";
  reason?: string;
  threadId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DraftBatchResult {
  results: DraftBatchItemResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

/**
 * Drafts outreach emails for every eligible EXTRACTED article in a run:
 * status EXTRACTED, author's best ContactAttempt (Day 6 priority) has an
 * emailCandidate, and no EmailThread exists yet for the article (idempotency
 * — same pattern as prior days' stage runners). Stops once
 * `Setting.maxDraftsPerRun` successful drafts have been created. Re-reads
 * the *live* Setting value (not PipelineRun.maxDrafts's create-time
 * snapshot) since the brief names `Setting.maxDraftsPerRun` directly and
 * drafting, unlike search, is a repeatable manual action that can run long
 * after the run was created — the snapshot stays as historical record only.
 */
export async function runDraftEmailsStage(
  runId: string,
  draftService: EmailDraftService,
): Promise<DraftBatchResult> {
  const settings = await prisma.setting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  const articles = await prisma.article.findMany({
    where: { pipelineRunId: runId, status: "EXTRACTED" },
    select: {
      id: true,
      title: true,
      url: true,
      sourceName: true,
      sourceDomain: true,
      author: {
        select: {
          id: true,
          name: true,
          contactAttempts: { select: { id: true, status: true, emailCandidate: true } },
        },
      },
      emailThreads: { select: { id: true } },
    },
  });

  const results: DraftBatchItemResult[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let draftedCount = 0;

  for (const article of articles) {
    if (draftedCount >= settings.maxDraftsPerRun) break;

    // Idempotency: an article that already has a thread is simply excluded,
    // not reported as a failure — it already has a draft to review.
    if (article.emailThreads.length > 0) continue;
    if (!article.author) continue;

    const best = bestContactAttempt(article.author.contactAttempts);
    if (!best?.emailCandidate) {
      results.push({
        articleId: article.id,
        outcome: "failed",
        reason: "No usable contact email found for this author.",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
      continue;
    }

    try {
      const draft = await draftService.draftEmail({
        article: {
          title: article.title,
          url: article.url,
          sourceName: article.sourceName,
          sourceDomain: article.sourceDomain,
        },
        authorName: article.author.name,
        persona: {
          companyName: settings.companyName,
          senderName: settings.senderName,
          senderRole: settings.senderRole,
          productPitch: settings.productPitch,
        },
      });

      totalInputTokens += draft.inputTokens;
      totalOutputTokens += draft.outputTokens;

      const thread = await prisma.emailThread.create({
        data: {
          articleId: article.id,
          authorId: article.author.id,
          contactAttemptId: best.id,
          recipientEmail: best.emailCandidate,
          subject: draft.subject,
          status: "DRAFT",
          messages: {
            create: {
              direction: "OUTBOUND",
              aiGenerated: true,
              approvedByUser: false,
              body: draft.body,
            },
          },
        },
        select: { id: true },
      });

      draftedCount += 1;
      results.push({
        articleId: article.id,
        outcome: "drafted",
        threadId: thread.id,
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
        costUsd: draft.costUsd,
      });
    } catch (error) {
      if (error instanceof EmailDraftError) {
        totalInputTokens += error.inputTokens;
        totalOutputTokens += error.outputTokens;
        results.push({
          articleId: article.id,
          outcome: "failed",
          reason: error.message,
          inputTokens: error.inputTokens,
          outputTokens: error.outputTokens,
          costUsd: estimateCostUsd(error.inputTokens, error.outputTokens),
        });
      } else {
        results.push({
          articleId: article.id,
          outcome: "failed",
          reason: "Drafting failed unexpectedly.",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
      }
    }
  }

  return {
    results,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: estimateCostUsd(totalInputTokens, totalOutputTokens),
  };
}
