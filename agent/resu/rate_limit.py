"""Process-wide guardrails against the Azure gpt-4.1 deployment's per-minute
token rate limit. A single resume generation can fan out many concurrent LLM
calls (one per entry's narrative extraction, each itself chunked into one
call per ~12k-char chunk) — without a shared cap, that burst reliably trips
the deployment's rate limit and surfaces as an opaque 500 from run-turn.
"""
from __future__ import annotations

import asyncio
import os
import random
from typing import Awaitable, Callable, TypeVar

from pydantic_ai.exceptions import ModelHTTPError

# Concurrent LLM calls across the whole process, not per-request — shared by
# both the narrative write-up agent (stories/agent.py) and the main resu
# agent (agent.py), since a burst in either one draws from the same Azure
# deployment quota. Conservative by default; override via env if the
# deployment's quota is raised.
LLM_CONCURRENCY = asyncio.Semaphore(int(os.environ.get("LLM_MAX_CONCURRENCY", "2")))

T = TypeVar("T")


async def retry_on_rate_limit(call: Callable[[], Awaitable[T]], max_attempts: int = 5) -> T:
    """Retries an awaitable-producing call with exponential backoff + jitter
    whenever it raises a 429 ModelHTTPError, re-raising anything else (or the
    429 itself once attempts are exhausted) immediately. Used both for the
    narrative write-up sub-agent's single model call and for the main resu
    agent's whole multi-step `.run()` — a 429 can surface from any model
    request inside that run, and since nothing is mutated until `.run()`
    returns, retrying the entire call is safe.
    """
    for attempt in range(max_attempts):
        try:
            return await call()
        except ModelHTTPError as e:
            if e.status_code != 429 or attempt == max_attempts - 1:
                raise
            # Per-minute token quota — a short fixed retry would likely hit
            # it again; this spreads retries out enough for the window to
            # roll over.
            delay = (2**attempt) + random.uniform(0, 1)
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")
