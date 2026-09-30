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
- `deploy.sh` — the deploy pipeline (see Deployment section below). Run it, don't scp.

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
- **Deploy with `bash deploy.sh`** (run from the local repo root, not on the server).
  It SSHs in, `git pull`s `~/job-tracker` (a real clone of this repo's `origin`),
  installs Node/Python deps, runs `prisma migrate deploy` + `prisma generate`, builds
  `apps/api` and `apps/web`, restarts all three PM2 services, and health-checks both
  the API and web app before reporting done. Commit and push first — it deploys
  whatever's on `origin/master`, not local working-tree changes.
- Do not scp individual files to the server as a substitute for `deploy.sh` — it works
  in the moment but leaves the server's git working tree with uncommitted local
  changes that then block the next `git pull` with "local changes would be
  overwritten by merge," and untracked files block it too ("untracked working tree
  files would be overwritten"). If you ever must patch something directly on the
  server for fast iteration, get the equivalent change committed and pushed
  afterward, then run `deploy.sh` (or at least `git status`/`git diff` on the server)
  to reconcile before trusting `git pull` there again — check the diff DIRECTION
  file-by-file first (`git diff -b origin/master -- <file>`, `-b` to ignore line-ending
  noise) since either side can legitimately be ahead; don't assume and don't discard
  without verifying.
- On the server, `pnpm`/`pm2`/`uv` aren't on the default non-interactive SSH `$PATH` —
  `deploy.sh` already sets this up; for a one-off manual command use:
  ```bash
  PATH=/usr/lib/node_modules/corepack/shims:/mnt/ssd/npm-global/bin:/home/pavan-mazumdar/.local/bin:$PATH pnpm ...
  /mnt/ssd/npm-global/bin/pm2 ...
  ```
- `job-tracker-web` and `job-tracker-agent` both need `--interpreter bash` if you ever
  start them manually with `pm2 start` — their real entrypoints
  (`node_modules/.bin/next`, and the `uv run uvicorn ...` command) are shell
  scripts/command strings, not plain JS, and PM2's default fork-mode interpreter fails
  on them with `SyntaxError: missing ) after argument list`. `deploy.sh` already does
  this correctly — see the script for the exact invocation shape.
- After a `job-tracker-api` restart, the very first request can transiently fail
  (`TypeError: fetch failed` from a caller) for a few seconds while it comes up — this
  is expected, not a bug; retry once rather than chasing it. Similarly, if a Prisma
  column's type changed in a migration, requests can fail with Postgres error
  `"cached plan must not change result type"` until the API process restarts and
  drops its stale cached query plans — another restart fixes it, not a real bug.
- Prisma migrations: hand-write the SQL (`apps/api/prisma/migrations/<timestamp>_<name>/
  migration.sql`) rather than trusting an auto-diff when a table has existing rows the
  diff could drop/require unsafely. `deploy.sh` applies migrations automatically; when
  testing one in isolation, apply with `pnpm exec prisma migrate deploy` on the server,
  then `pnpm exec prisma generate` before building.

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
