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

## Local setup

```bash
docker compose up -d          # Postgres on :5433
pnpm install

cp apps/api/.env.example apps/api/.env      # fill in Azure OpenAI creds
cp agent/.env.example agent/.env

cd apps/api && pnpm db:migrate && cd ../..

pnpm dev                       # web :3100, api :4100

cd agent && uv sync && uv run uvicorn resu.service:app --port 8741
```
