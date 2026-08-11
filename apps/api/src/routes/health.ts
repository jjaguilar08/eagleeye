import type { FastifyInstance } from "fastify";
import type { HealthStatus } from "@eagleeye/types";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (): Promise<HealthStatus> => {
    return { status: "ok" };
  });
}
