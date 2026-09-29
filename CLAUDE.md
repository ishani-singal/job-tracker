# Claude Code Instructions

## Subagents — minimize usage
- Do NOT use subagents by default.
- Only spawn a subagent when the task clearly benefits from independent parallel work.
- Prefer completing the task directly.
- Maximum concurrent subagents: 2.
- Maximum subagent spawn depth: 1.
- Subagents may NOT spawn additional subagents.
- Never create multiple subagents to investigate the same problem.
- Keep subagent tasks narrowly scoped.
- Do not use Explore or Plan agents for simple tasks.
- Do not delegate tasks that can be completed by inspecting a few files directly.
- Prefer a single focused subagent over multiple subagents.
- Subagents should return concise findings rather than large explanations.

## Context / Token Efficiency
- Use targeted searches before reading files.
- Do not scan the entire repository unless necessary.
- Read only the relevant portions of files.
- Do not repeatedly inspect files or search for information already established.
- Avoid unrelated exploration.
- Stop investigating once sufficient information is available.
- Keep working context focused on the current task.
- When the current task is complete, do not continue exploring.

## Implementation
- Make the smallest change that solves the request.
- Do not refactor unrelated code.
- Reuse existing code and patterns.
- Do not create unnecessary abstractions.
- Do not modify unrelated files.

## Testing / Validation
- Building is part of deploying, not optional testing — `apps/api` and `apps/web` are
  both served from compiled/built output on the server, so `pnpm build` for whichever
  app changed is a required step of every deploy, not something to skip by default.
- NEVER run the test suite unless explicitly asked.
- NEVER run linters standalone unless explicitly asked (the build's own type-checking,
  which happens automatically, is fine and expected).
- NEVER run formatters unless explicitly asked.

## Communication
- Keep responses concise.
- Do not repeat my requirements.
- Report what changed, relevant files, and any important issues.

## Repo Structure
- `apps/api` — NestJS + Fastify + Prisma REST API (applications, resumes, settings,
  jobs, analytics, company-roles).
- `apps/web` — Next.js 15 frontend.
- `packages/shared-types` — TS types shared between api/web (no build step; consumed
  as source via workspace linking).
- `agent/resu` — PydanticAI resume-generation agent, exposed over FastAPI.
- `agent/linkedin` — PydanticAI LinkedIn-profile-drafting agent, same FastAPI process
  pattern as `agent/resu`.
- `extension/` — Chrome/Edge (Manifest V3) browser extension for quick job-application
  capture from any posting tab; see `extension/README.md`.

## Deployment
- Runs on `pavan-mazumdar-server` (SSH as `pavan-mazumdar`), app dir `~/job-tracker`,
  managed by PM2. This server also hosts other unrelated projects (Finra, Soma) —
  don't touch their PM2 processes or ports.
- PM2 process names / ports:
  | Service | PM2 name | Port |
  |---|---|---|
  | Postgres | `job-tracker-postgres` (plain `docker run`, not compose) | 5433 |
  | API | `job-tracker-api` | 4100 |
  | Web | `job-tracker-web` | 3100 |
  | Resu + LinkedIn agent | `job-tracker-agent` | 8743 |
- No CI/CD — deploy by hand:
  ```bash
  scp <changed file> pavan-mazumdar@pavan-mazumdar-server:~/job-tracker/<same path>
  ssh pavan-mazumdar@pavan-mazumdar-server
  cd ~/job-tracker/apps/api && pnpm build   # if API changed
  cd ~/job-tracker/apps/web && pnpm build   # if web changed
  # agent/*.py changes need no build step — just restart job-tracker-agent
  pm2 restart job-tracker-api job-tracker-web job-tracker-agent   # only the ones that changed
  ```
- On the server, `pnpm`/`pm2` aren't on the default non-interactive SSH `$PATH` — use:
  ```bash
  PATH=/usr/lib/node_modules/corepack/shims:/mnt/ssd/npm-global/bin:$PATH pnpm ...
  /mnt/ssd/npm-global/bin/pm2 ...
  ```
- After a `job-tracker-api` restart, the very first request can transiently fail
  (`TypeError: fetch failed` from a caller) for a few seconds while it comes up — this
  is expected, not a bug; retry once rather than chasing it.
- Prisma migrations: hand-write the SQL (`apps/api/prisma/migrations/<timestamp>_<name>/
  migration.sql`) rather than trusting an auto-diff when a table has existing rows the
  diff could drop/require unsafely. Apply with
  `pnpm exec prisma migrate deploy` on the server, then `pnpm exec prisma generate`
  before building.

## Database Access
- Server: `pavan-mazumdar-server` (SSH as `pavan-mazumdar`), app dir `~/job-tracker`.
- Postgres runs in Docker, container name: `job-tracker-postgres` (port 5433 — do not
  confuse with the unrelated `finagent-postgres` container also on this server, on 5432).
- Credentials: user `jobtracker`, password `jobtracker_dev_password`, database `jobtracker`.
  ```bash
  docker exec -it job-tracker-postgres psql -U jobtracker -d jobtracker -c "<SQL>"
  ```
- NEVER delete or replace the current database (drops, truncates, `docker rm`/`volume rm`,
  or restoring/overwriting from a backup) without explicit, clear permission from the user
  for that specific action.

## Git Workflow
- Local commits after each verified, deployed change — group a coherent unit of work
  into one commit with a real "why" in the message, not one commit per file edit.
- This repo now has a public GitHub remote (`origin` → `github.com/ishani-singal/
  job-tracker`, public since 2026-09-29). Push explicitly when asked, or when a commit
  is ready to share — don't push reflexively after every single commit.
- Before ever making a repo public (this one already is) or pushing, scan for secrets:
  no `.env` files, hardcoded API keys/passwords, or private infrastructure details
  (real server hostnames/IPs) belong in committed files — `.env.example` templates and
  placeholder values only. `.env`/`.env.local` are gitignored; keep it that way.
- Never force-push, reset --hard, or rewrite history on `master` without being asked.
