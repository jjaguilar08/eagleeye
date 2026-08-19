import type { FastifyInstance } from "fastify";
import type { UpdateEmailDraftRequest } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";
import { emailThreadSelect } from "./pipeline-runs.js";
import {
  EmailSendError,
  EmailSenderService,
  WhitelistRejectedError,
} from "../services/email-sender.js";

// A "send" is any OUTBOUND Message with a non-null sentAt. Rolling 24h
// window rather than a calendar-day boundary — unambiguous with no timezone
// decision needed, and just as simple to compute.
const DAILY_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

function findThread(id: string) {
  return prisma.emailThread.findUnique({ where: { id }, select: emailThreadSelect });
}

// The outbound draft message is always the first (and, as of Day 8, only)
// OUTBOUND message on a thread — approve/reject/edit all act on it.
function findOutboundMessage(id: string) {
  return prisma.message.findFirst({
    where: { threadId: id, direction: "OUTBOUND" },
    orderBy: { createdAt: "asc" },
  });
}

export async function emailThreadRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/email-threads/:id/approve", async (request, reply) => {
    const thread = await findThread(request.params.id);
    if (!thread) {
      return reply.code(404).send({ error: "Email thread not found" });
    }

    const outbound = await findOutboundMessage(thread.id);
    if (!outbound) {
      return reply.code(500).send({ error: "Email thread has no outbound draft message." });
    }

    await prisma.$transaction([
      prisma.message.update({ where: { id: outbound.id }, data: { approvedByUser: true } }),
      prisma.emailThread.update({ where: { id: thread.id }, data: { status: "PENDING_APPROVAL" } }),
    ]);

    return (await findThread(thread.id))!;
  });

  app.post<{ Params: { id: string } }>("/email-threads/:id/reject", async (request, reply) => {
    const thread = await findThread(request.params.id);
    if (!thread) {
      return reply.code(404).send({ error: "Email thread not found" });
    }

    await prisma.emailThread.update({ where: { id: thread.id }, data: { status: "CLOSED" } });

    return (await findThread(thread.id))!;
  });

  app.patch<{ Params: { id: string }; Body: UpdateEmailDraftRequest }>(
    "/email-threads/:id/draft",
    async (request, reply) => {
      const { subject, body } = request.body ?? {};

      if (typeof subject !== "string" || subject.trim() === "") {
        return reply.code(400).send({ error: "subject is required" });
      }
      if (typeof body !== "string" || body.trim() === "") {
        return reply.code(400).send({ error: "body is required" });
      }

      const thread = await findThread(request.params.id);
      if (!thread) {
        return reply.code(404).send({ error: "Email thread not found" });
      }

      const outbound = await findOutboundMessage(thread.id);
      if (!outbound) {
        return reply.code(500).send({ error: "Email thread has no outbound draft message." });
      }

      // Editing always resets approval and status back to DRAFT, even if it
      // was previously approved — an edit invalidates any prior approval, a
      // fresh explicit approve is required afterward.
      await prisma.$transaction([
        prisma.message.update({
          where: { id: outbound.id },
          data: { body, approvedByUser: false },
        }),
        prisma.emailThread.update({
          where: { id: thread.id },
          data: { subject, status: "DRAFT" },
        }),
      ]);

      return (await findThread(thread.id))!;
    },
  );

  // The single most consequential action in the app — it actually delivers
  // an email to a real inbox. Every gate below is checked server-side, each
  // failing with its own specific reason rather than one generic error, and
  // the whitelist is checked again here even though EmailSenderService.send
  // already enforces it internally — belt and suspenders on the one action
  // that matters most.
  app.post<{ Params: { id: string } }>("/email-threads/:id/send", async (request, reply) => {
    const settings = await prisma.setting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });

    if (!settings.automationEnabled) {
      return reply
        .code(403)
        .send({ error: "Automation is disabled. Enable it in Settings before sending." });
    }

    const thread = await findThread(request.params.id);
    if (!thread) {
      return reply.code(404).send({ error: "Email thread not found" });
    }

    const outbound = await findOutboundMessage(thread.id);
    if (!outbound) {
      return reply.code(500).send({ error: "Email thread has no outbound draft message." });
    }

    if (!outbound.approvedByUser || thread.status !== "PENDING_APPROVAL") {
      return reply
        .code(403)
        .send({ error: "This draft has not been approved yet. Approve it before sending." });
    }

    const whitelisted = await prisma.whitelistEntry.findUnique({
      where: { email: thread.recipientEmail.toLowerCase() },
    });
    if (!whitelisted) {
      return reply.code(403).send({
        error: `${thread.recipientEmail} is not on the whitelist. Add it in Settings before sending.`,
      });
    }

    // Re-reads the live Setting.maxSendsPerRun/dailySendCap rather than
    // PipelineRun.maxSends's create-time snapshot — same reasoning as Day
    // 8's draft-emails cap: the brief names the Setting field directly, and
    // sending is a repeatable manual action that can happen long after the
    // run was created.
    const article = await prisma.article.findUniqueOrThrow({
      where: { id: thread.articleId },
      select: { pipelineRunId: true },
    });

    const sentInRun = await prisma.message.count({
      where: {
        direction: "OUTBOUND",
        sentAt: { not: null },
        thread: { article: { pipelineRunId: article.pipelineRunId } },
      },
    });
    if (sentInRun >= settings.maxSendsPerRun) {
      return reply.code(403).send({
        error: `This run has already reached its send limit (${settings.maxSendsPerRun}).`,
      });
    }

    const sentToday = await prisma.message.count({
      where: {
        direction: "OUTBOUND",
        sentAt: { not: null, gte: new Date(Date.now() - DAILY_SEND_WINDOW_MS) },
      },
    });
    if (sentToday >= settings.dailySendCap) {
      return reply
        .code(403)
        .send({ error: `The daily send cap (${settings.dailySendCap}) has already been reached.` });
    }

    const apiKey = process.env["RESEND_API_KEY"];
    const fromEmail = process.env["RESEND_FROM_EMAIL"];
    if (!apiKey || !fromEmail) {
      return reply.code(500).send({
        error: "Sending is not configured: missing RESEND_API_KEY or RESEND_FROM_EMAIL.",
      });
    }

    const senderService = new EmailSenderService({ apiKey });

    try {
      await senderService.send({
        to: thread.recipientEmail,
        from: fromEmail,
        senderName: settings.senderName,
        subject: thread.subject,
        body: outbound.body,
      });
    } catch (error) {
      if (error instanceof WhitelistRejectedError) {
        return reply.code(403).send({ error: error.message });
      }
      const message = error instanceof EmailSendError ? error.message : "Failed to send email.";
      return reply.code(502).send({ error: message });
    }

    await prisma.$transaction([
      prisma.message.update({ where: { id: outbound.id }, data: { sentAt: new Date() } }),
      prisma.emailThread.update({ where: { id: thread.id }, data: { status: "SENT" } }),
    ]);

    return (await findThread(thread.id))!;
  });
}
