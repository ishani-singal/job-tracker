# Job Tracker

Single-user job application tracker + AI resume tailoring. Standalone app, built to be
onboarded into Soma later — see `agent/resu/` for the portable PydanticAI agent and the
plan doc this was scaffolded from for the full design rationale.

## Structure

- `apps/api` — NestJS + Fastify + Prisma REST API (applications, resumes, settings, jobs, analytics)
- `apps/web` — Next.js 15 frontend
- `packages/shared-types` — TS types shared between api/web
- `agent/resu` — PydanticAI resume-generation agent, exposed over FastAPI for the standalone app;
  Soma-portable folder shape (see `new-agent` onboarding skill)

## Deployment

Runs on a personal server (`<your-host>`) managed by PM2:

| Service | PM2 name | Port |
|---|---|---|
| Postgres | `job-tracker-postgres` (plain `docker run`, not compose) | 5433 |
| API | `job-tracker-api` | 4100 |
| Web | `job-tracker-web` | 3100 |
| Resume agent | `job-tracker-agent` | 8743 |

Port 8741 is already Soma's backend (`soma-backend` systemd service) on that server —
don't reuse it here.

Source lives at `~/job-tracker` on the server, pushed via `scp`/tarball (no git remote
yet — this repo hasn't been pushed anywhere). `.env`/`.env.local` files are **not**
committed; they're copied directly to the server and must be kept in sync manually until a
real deploy script exists (see Finra's `deploy.sh` for the pattern to follow once this
graduates past manual scp'ing).

**Important**: `apps/web/.env.local` must point `NEXT_PUBLIC_API_URL` at the server's
address (e.g. `http://<your-host>:4100`), not `localhost` — it's baked into the client bundle
at build time and read from the *browser*, so `localhost` there means the visitor's own
machine, not the server. Getting this wrong makes API calls (uploads, etc.) fail silently
with no visible error unless the caller checks `res.ok`.

To redeploy after a code change:
```bash
scp <changed file> <user>@<your-host>:~/job-tracker/<same path>
ssh <user>@<your-host>
cd ~/job-tracker/apps/api && pnpm build   # if API changed
pm2 restart job-tracker-api job-tracker-web job-tracker-agent
```

## Local setup (alternative — if not using the server)

```bash
cp .env.example .env          # set POSTGRES_PASSWORD
docker compose up -d          # Postgres on :5433
pnpm install

cp apps/api/.env.example apps/api/.env      # fill in DATABASE_URL (match POSTGRES_* above) + Azure OpenAI creds (AZURE_LLM_*)
cp agent/.env.example agent/.env

cd apps/api && pnpm db:migrate && cd ../..

pnpm dev                       # web :3100, api :4100

cd agent && uv sync && uv run uvicorn resu.service:app --port 8743
```
