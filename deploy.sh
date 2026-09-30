#!/usr/bin/env bash
# Deploy script for pavan-mazumdar-server.
#
# Run from your LOCAL machine (not on the server):
#   bash deploy.sh
#
# This script SSHs in and, on the server:
#   1. git pulls latest master (this repo has a real remote now — no more scp'ing
#      individual files)
#   2. installs Node deps, runs Prisma migrations, regenerates the Prisma client
#   3. builds apps/api and apps/web
#   4. restarts job-tracker-api / job-tracker-web / job-tracker-agent via PM2
#   5. verifies job-tracker-api actually came back up (health check, not just
#      "pm2 says restarted")
set -euo pipefail

SERVER=pavan-mazumdar@100.96.199.11

echo "==> Deploying to $SERVER..."
# shellcheck disable=SC2087
ssh "$SERVER" 'bash -s' << 'REMOTE_SCRIPT'
set -euo pipefail

EXTRA_PATH=/usr/lib/node_modules/corepack/shims:/mnt/ssd/npm-global/bin:/home/pavan-mazumdar/.local/bin
PM2=/mnt/ssd/npm-global/bin/pm2
JOB_TRACKER=~/job-tracker
API=$JOB_TRACKER/apps/api
WEB=$JOB_TRACKER/apps/web
AGENT=$JOB_TRACKER/agent

export PATH="$EXTRA_PATH:$PATH"

echo "==> Pulling latest code..."
cd $JOB_TRACKER
git pull origin master

echo "==> Installing Node dependencies..."
pnpm install --frozen-lockfile

echo "==> Installing Python dependencies (agent)..."
cd $AGENT
uv sync

echo "==> Running database migrations..."
cd $API
pnpm exec prisma migrate deploy

echo "==> Generating Prisma client..."
pnpm exec prisma generate

echo "==> Building api..."
pnpm build

echo "==> Building web..."
cd $WEB
pnpm build

echo "==> Restarting services..."
# pm2 restart is a no-op if the named process isn't currently registered — delete-then-start
# each one explicitly so a missing process always gets (re)created rather than silently
# staying down.
$PM2 delete job-tracker-api 2>/dev/null || true
$PM2 start $API/dist/main.js --name job-tracker-api --cwd $API --update-env

$PM2 delete job-tracker-web 2>/dev/null || true
# node_modules/.bin/next (and pnpm itself) are #!/bin/sh shell shims, not JS —
# PM2's default fork-mode interpreter tries to run them as Node and fails
# with "SyntaxError: missing ) after argument list". --interpreter bash fixes it.
$PM2 start $WEB/node_modules/.bin/next --name job-tracker-web --cwd $WEB --interpreter bash --update-env -- start -p 3100

$PM2 delete job-tracker-agent 2>/dev/null || true
$PM2 start bash --name job-tracker-agent --cwd $AGENT --update-env \
  -- -c "uv run uvicorn resu.service:app --port 8743 --host 0.0.0.0"

echo "==> Saving PM2 process list..."
$PM2 save

echo "==> Done. Status:"
$PM2 list

echo ""
echo "==> Verifying job-tracker-api startup..."
HEALTH_OK=false
for i in $(seq 1 15); do
  if curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:4100/tracked-companies 2>/dev/null | grep -q '^200$'; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" = true ]; then
  echo "    job-tracker-api started OK (health check passed)"
else
  echo "    WARNING: job-tracker-api health check failed after 15s — check: pm2 logs job-tracker-api"
  tail -n 30 ~/.pm2/logs/job-tracker-api-error.log 2>/dev/null | grep -i "error" | tail -5 || true
fi

echo "==> Verifying job-tracker-web startup..."
WEB_HEALTH_OK=false
for i in $(seq 1 20); do
  if curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:3100/applications 2>/dev/null | grep -q '^200$'; then
    WEB_HEALTH_OK=true
    break
  fi
  sleep 1
done

if [ "$WEB_HEALTH_OK" = true ]; then
  echo "    job-tracker-web started OK (health check passed)"
else
  echo "    WARNING: job-tracker-web health check failed after 20s — check: pm2 logs job-tracker-web"
  tail -n 30 ~/.pm2/logs/job-tracker-web-error.log 2>/dev/null | tail -10 || true
fi
REMOTE_SCRIPT

echo "==> Deploy finished."
