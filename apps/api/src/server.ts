import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import { settingsRoutes } from "./routes/settings.js";
import { pipelineRunRoutes } from "./routes/pipeline-runs.js";

const app = Fastify({ logger: true });

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
