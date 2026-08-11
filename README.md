# EagleEye

A portfolio rebuild of an automated marketing/outreach tool.

> **Demo-only portfolio project.** EagleEye never sends real email to
> non-whitelisted recipients, and it never runs any outreach automation
> without deliberate, explicit action. The running app itself is **not**
> deployed publicly — only a separate, static landing page will be public
> later. This repo exists to demonstrate engineering practice, not to operate
> as a real outreach tool.

## What's here so far (Day 1 — scaffolding only)

This is Day 1 of a 15-day build. Today is scaffolding only: no search,
crawling, extraction, AI drafting, or email sending yet — that's later
milestones. Day 1 delivers:

- A pnpm workspace monorepo: `apps/api` (Fastify), `apps/web` (Next.js),
  `packages/types` (shared TS types).
- Shared strict TypeScript config, ESLint (flat config) + Prettier across
  the workspace, EditorConfig, and a Husky + lint-staged pre-commit hook.
- Local infra via `docker-compose` (Postgres + Redis) and a Prisma CLI
  wired up to Postgres — no schema/models yet, that's Day 2.
- A Fastify skeleton with a single `GET /health` route.
- A Next.js (App Router) skeleton with a single placeholder dashboard page.
- CI (GitHub Actions): install, typecheck, lint, build. No deploy step —
  this app is never deployed publicly.

## Stack

- **API**: Fastify + TypeScript, Prisma (Postgres), on Node.js (current LTS).
- **Web**: Next.js (App Router) + TypeScript + Tailwind CSS.
- **Shared**: `packages/types` for types shared between both apps.
- **Infra (local dev)**: Postgres + Redis via Docker Compose.
- **Tooling**: pnpm workspaces, ESLint (flat config), Prettier, Husky +
  lint-staged, GitHub Actions.

## Setup

Prerequisites: Node.js (see `.nvmrc`), [pnpm](https://pnpm.io) (via
[Corepack](https://nodejs.org/api/corepack.html): `corepack enable`), and
Docker (for local Postgres/Redis).

```bash
git clone git@github.com:jjaguilar08/eagleeye.git
cd eagleeye
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```

- API: http://localhost:4000/health → `{ "status": "ok" }`
- Web: http://localhost:3000

Other useful scripts (run from the repo root, apply across the whole
workspace):

```bash
pnpm build       # build all apps/packages
pnpm lint        # lint the whole workspace
pnpm typecheck   # typecheck all apps/packages
pnpm format      # format with Prettier
```

## Notes / deviations from spec

- **Node version**: pinned to Node 24 (current Active LTS as of this
  writing) rather than the Node 20 example in the original brief, since
  Node 20 has since moved out of Active LTS.
- **Env vars**: a single `.env.example` lives at the repo root (not
  per-app) and is the one source of truth for local dev config. Prisma's
  `prisma.config.ts` in `apps/api` explicitly loads the root `.env` rather
  than expecting its own copy, so there's only ever one file to edit.
- **ESLint**: one shared flat config at the repo root lints the entire
  workspace (rather than a separate config per app), including
  React/React-Hooks rules scoped to `apps/web`, for consistency.
- **Styling**: Tailwind CSS, as suggested as an acceptable default in the
  brief.
- **Docker verification**: Docker wasn't available in the sandbox this repo
  was scaffolded in, so `docker compose up -d` and a live Prisma connection
  could not be exercised end-to-end here. `docker-compose.yml` was written
  by hand and `prisma validate` / `prisma generate` were run successfully
  against the schema; please verify `docker compose up -d` + a live DB
  connection on a machine with Docker before relying on it.
