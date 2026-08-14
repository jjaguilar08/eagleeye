import path from "node:path";
import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";

// Root .env, not a per-app copy — same reasoning/pattern as apps/api/prisma.config.ts.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env") });

const nextConfig: NextConfig = {
  // NEXT_PUBLIC_ vars are normally auto-inlined only from apps/web's own env
  // files; since env config lives at the repo root instead, `env` here makes
  // the value (loaded above) available at build/dev time too.
  env: {
    NEXT_PUBLIC_API_URL: process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000",
  },
};

export default nextConfig;
