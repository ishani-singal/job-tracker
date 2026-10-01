"""Process-wide guardrails against the Azure gpt-4.1 deployment's per-minute
token rate limit. A single resume generation can fan out many concurrent LLM
calls (one per entry's narrative extraction, each itself chunked into one
call per ~12k-char chunk) — without a shared cap, that burst reliably trips
the deployment's rate limit and surfaces as an opaque 500 from run-turn.
"""
from __future__ import annotations

import asyncio
import os

# Concurrent LLM calls across the whole process, not per-request — shared by
# both the narrative write-up agent (stories/agent.py) and the main resu
# agent (agent.py), since a burst in either one draws from the same Azure
# deployment quota. Conservative by default; override via env if the
# deployment's quota is raised.
LLM_CONCURRENCY = asyncio.Semaphore(int(os.environ.get("LLM_MAX_CONCURRENCY", "2")))
