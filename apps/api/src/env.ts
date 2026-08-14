import path from "node:path";
import { config as loadEnv } from "dotenv";

// Must be the first thing imported by server.ts (before any module that
// reads process.env at load time, e.g. the Prisma client singleton) — see
// prisma.config.ts for the same root-.env-loading pattern.
loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env") });
