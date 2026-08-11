# EagleEye — Project Notes

A running log of context, decisions, and follow-ups across the 15-day
build — not a changelog of every commit, and not a duplicate of the
README's setup instructions. Read this first when picking the project
back up after a break.

Append a new `## Day N — <date> — <headline>` section per day. Keep
entries short: what shipped, decisions worth remembering and why,
follow-ups for later days, gotchas hit along the way.

---

## Day 1 — 2026-08-11 — Scaffolding

**Shipped**: pnpm workspace monorepo (`apps/api` Fastify, `apps/web`
Next.js App Router, `packages/types` shared types); strict shared
TypeScript config; ESLint flat config + Prettier + Husky/lint-staged;
`docker-compose.yml` for local Postgres + Redis; Prisma CLI wired up
in `apps/api` (no schema/models yet); GitHub Actions CI (install,
typecheck, lint, build); MIT license; repo live and public at
https://github.com/jjaguilar08/eagleeye.

No search, crawling, extraction, AI drafting, or email sending yet —
those are later milestones. Today was scaffolding only.

**Decisions**:

- Node 24 (current Active LTS), not the Node 20 mentioned as an example
  in the original brief — 20 has since rolled out of Active LTS.
- Single root `.env` / `.env.example` (not per-app). `apps/api/prisma.config.ts`
  explicitly loads the root `.env` so there's exactly one file to edit.
- One shared root `eslint.config.js` (flat config) lints the whole
  workspace, with React/Hooks rules scoped to `apps/web` via a `files`
  block, rather than a separate ESLint config per app.
- `packages/types` must be built (`tsc`) before apps can typecheck/run
  against it, since apps resolve it via `dist/`. Root `dev` and
  `typecheck` scripts prepend a `pnpm --filter @eagleeye/types run build`
  step for this reason — remember this if adding new root scripts that
  touch apps.
- Tailwind CSS for `apps/web` styling (brief left this open).

**Follow-ups for Day 2+**:

- Docker wasn't available in the sandbox this repo was scaffolded in, so
  `docker compose up -d` and a live Prisma→Postgres connection were never
  actually exercised — only `prisma validate`/`prisma generate` (schema-only,
  no DB needed) were confirmed. **Verify `docker compose up -d` and a real
  Prisma connection on a machine with Docker before building on top of it.**
- Prisma schema (`apps/api/prisma/schema.prisma`) has no models yet — Day 2
  per the milestone plan.

**Gotchas hit**:

- Next.js 16's generated `LayoutProps<"/">` ambient type only exists after
  a `next build`/`next dev` has populated `.next/types`. Locally this was
  masked by a leftover `.next` from manual testing, but a genuinely clean
  checkout failed `tsc --noEmit` in CI. Fixed by using an explicit
  `{ children: ReactNode }` prop type in `apps/web/src/app/layout.tsx`
  instead of relying on the generated global.
- Next.js 16 auto-regenerates `apps/web/AGENTS.md` / `CLAUDE.md` on every
  `next dev`/`next build` run (agent-facing guidance about Next 16 breaking
  changes vs. training data). These are committed on purpose — the
  generated file itself notes that removing them just re-creates an
  uncommitted diff on the next dev/build.
