import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

const app = Fastify({ logger: true });

await app.register(healthRoutes);

const port = Number(process.env["PORT"] ?? 4000);
const host = process.env["HOST"] ?? "0.0.0.0";

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
