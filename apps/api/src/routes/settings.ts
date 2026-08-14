import type { FastifyInstance } from "fastify";
import type { SettingDTO, UpdateSettingRequest } from "@eagleeye/types";
import { prisma } from "../lib/prisma.js";

// The Setting row is a singleton enforced at the app level (see schema.prisma
// doc comment on Setting) — every read/write upserts id:1 rather than
// assuming the seed already ran.
async function getOrCreateSettings(): Promise<SettingDTO> {
  return prisma.setting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings", async (): Promise<SettingDTO> => {
    return getOrCreateSettings();
  });

  app.patch<{ Body: UpdateSettingRequest }>("/settings", async (request, reply) => {
    const { automationEnabled, searchTopic } = request.body ?? {};

    if (automationEnabled !== undefined && typeof automationEnabled !== "boolean") {
      return reply.code(400).send({ error: "automationEnabled must be a boolean" });
    }
    if (
      searchTopic !== undefined &&
      (typeof searchTopic !== "string" || searchTopic.trim() === "")
    ) {
      return reply.code(400).send({ error: "searchTopic must be a non-empty string" });
    }

    await getOrCreateSettings();

    const updated: SettingDTO = await prisma.setting.update({
      where: { id: 1 },
      data: {
        ...(automationEnabled !== undefined && { automationEnabled }),
        ...(searchTopic !== undefined && { searchTopic }),
      },
    });

    return updated;
  });
}
