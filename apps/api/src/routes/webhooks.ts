import type { FastifyInstance } from "fastify";
import { InboundWebhookService, SignatureVerificationError } from "../services/inbound-webhook.js";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // svix signature verification needs the exact raw body Resend sent —
  // Fastify's default JSON parser would hand us a re-parsed object, and
  // JSON.stringify()-ing it back can differ in whitespace/key order and
  // silently break verification. Overriding the parser here only affects
  // routes registered inside this same plugin (Fastify content-type parsers
  // are encapsulated per-plugin), so every other route keeps normal JSON
  // parsing.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  // Deliberately NOT gated by Setting.automationEnabled, unlike every other
  // route that spends money or sends something (pipeline runs, AI drafting,
  // /email-threads/:id/send). automationEnabled exists to stop *us* from
  // initiating costly/consequential outbound action — this route is the
  // opposite: Resend calling us reactively about a reply that already
  // happened out in the world. It never sends anything and costs nothing,
  // and dropping a real reply because a toggle happened to be off would
  // silently lose data with no way to recover it later.
  app.post("/webhooks/resend-inbound", async (request, reply) => {
    const apiKey = process.env["RESEND_API_KEY"];
    const webhookSecret = process.env["RESEND_WEBHOOK_SECRET"];
    if (!apiKey || !webhookSecret) {
      return reply.code(500).send({
        error:
          "Inbound webhook is not configured: missing RESEND_API_KEY or RESEND_WEBHOOK_SECRET.",
      });
    }

    const service = new InboundWebhookService({ apiKey, webhookSecret });
    const rawBody = typeof request.body === "string" ? request.body : "";
    const headers = {
      id: request.headers["svix-id"] as string | undefined,
      timestamp: request.headers["svix-timestamp"] as string | undefined,
      signature: request.headers["svix-signature"] as string | undefined,
    };

    let result;
    try {
      result = await service.handle(rawBody, headers);
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        return reply.code(401).send({ error: error.message });
      }
      throw error;
    }

    if (result.outcome === "no_match") {
      request.log.warn(
        {
          domain: result.from.split("@")[1],
          from: result.from,
          to: result.to,
          subject: result.subject,
        },
        "Inbound reply from an address with no matching EmailThread — dropped, no orphan record created.",
      );
    }

    return reply.code(200).send({ ok: true });
  });
}
