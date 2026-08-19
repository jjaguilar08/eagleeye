import type { FastifyInstance } from "fastify";
import type { CreateWhitelistEntryRequest } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function whitelistRoutes(app: FastifyInstance): Promise<void> {
  app.get("/whitelist", async () => {
    return prisma.whitelistEntry.findMany({ orderBy: { createdAt: "asc" } });
  });

  app.post<{ Body: CreateWhitelistEntryRequest }>("/whitelist", async (request, reply) => {
    const { email, label } = request.body ?? {};

    if (typeof email !== "string" || email.trim() === "") {
      return reply.code(400).send({ error: "email is required" });
    }
    // Shape validation only — this isn't verifying deliverability, just
    // catching an obvious typo before it sits in the whitelist unusable.
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return reply.code(400).send({ error: "email does not look like a valid address" });
    }
    if (label !== undefined && typeof label !== "string") {
      return reply.code(400).send({ error: "label must be a string" });
    }

    try {
      const entry = await prisma.whitelistEntry.create({
        data: { email: normalizedEmail, label: label?.trim() || null },
      });
      return reply.code(201).send(entry);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: `${normalizedEmail} is already on the whitelist.` });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/whitelist/:id", async (request, reply) => {
    const entry = await prisma.whitelistEntry.findUnique({ where: { id: request.params.id } });
    if (!entry) {
      return reply.code(404).send({ error: "Whitelist entry not found" });
    }

    await prisma.whitelistEntry.delete({ where: { id: entry.id } });
    return reply.code(200).send(entry);
  });
}
