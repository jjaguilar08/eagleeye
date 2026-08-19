import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import { settingsRoutes } from "./routes/settings.js";
import { pipelineRunRoutes } from "./routes/pipeline-runs.js";
import { emailThreadRoutes } from "./routes/email-threads.js";
import { whitelistRoutes } from "./routes/whitelist.js";
import { startPipelineWorker } from "./lib/pipeline-queue.js";

const app = Fastify({ logger: true });

// Runs in this same process — no separate deployable worker, per the Day 7
// brief's "unnecessary complexity for a project that's never deployed live"
// reasoning. Only called here, at actual server startup — never at module
// import time, so typecheck/lint/test/build never need a live Redis.
startPipelineWorker();

await app.register(cors, {
  origin: process.env["WEB_ORIGIN"] ?? "http://localhost:3000",
  // @fastify/cors defaults to methods: "GET,HEAD,POST" — PATCH (used by
  // /settings since Day 3, and by Day 8's /email-threads/:id/draft) was
  // silently rejected by the browser's preflight the whole time. Only
  // curl-based verification ever exercised those routes; found live via a
  // real browser click on Day 8. List every method the API actually uses
  // rather than reaching for a wildcard — DELETE added for Day 9's
  // /whitelist/:id, double-checked live per Day 8's own lesson.
  methods: ["GET", "POST", "PATCH", "DELETE"],
});

await app.register(healthRoutes);
await app.register(settingsRoutes);
await app.register(pipelineRunRoutes);
await app.register(emailThreadRoutes);
await app.register(whitelistRoutes);

const port = Number(process.env["PORT"] ?? 4000);
const host = process.env["HOST"] ?? "0.0.0.0";

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
