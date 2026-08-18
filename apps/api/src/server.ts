import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import { settingsRoutes } from "./routes/settings.js";
import { pipelineRunRoutes } from "./routes/pipeline-runs.js";
import { startPipelineWorker } from "./lib/pipeline-queue.js";

const app = Fastify({ logger: true });

// Runs in this same process — no separate deployable worker, per the Day 7
// brief's "unnecessary complexity for a project that's never deployed live"
// reasoning. Only called here, at actual server startup — never at module
// import time, so typecheck/lint/test/build never need a live Redis.
startPipelineWorker();

await app.register(cors, {
  origin: process.env["WEB_ORIGIN"] ?? "http://localhost:3000",
});

await app.register(healthRoutes);
await app.register(settingsRoutes);
await app.register(pipelineRunRoutes);

const port = Number(process.env["PORT"] ?? 4000);
const host = process.env["HOST"] ?? "0.0.0.0";

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
