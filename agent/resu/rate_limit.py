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
import time
from typing import Awaitable, Callable, TypeVar

import httpx
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError

# The OpenAI/Azure SDK's own default httpx timeout is generous enough that a
# hung or silently-stalled connection to Azure can sit for a very long time
# with nothing ever raising — retry_on_rate_limit below only catches
# ModelHTTPError (a real error response), so a call that never gets ANY
# response (not even an error) just blocks forever, invisible to every
# retry/backoff/concurrency guardrail in this module. A real production
# generation got stuck for 10+ minutes with zero progress and no error this
# way. Every Azure-backed model in this agent should pass this as its
# http_client so a stalled connection surfaces as a catchable timeout
# instead of hanging indefinitely.
AZURE_HTTP_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

# Concurrent LLM calls across the whole process, not per-request — shared by
# both the narrative write-up agent (stories/agent.py) and the main resu
# agent (agent.py), since a burst in either one draws from the same Azure
# deployment quota. Conservative by default; override via env if the
# deployment's quota is raised.
LLM_CONCURRENCY = asyncio.Semaphore(int(os.environ.get("LLM_MAX_CONCURRENCY", "2")))

T = TypeVar("T")

# NestJS's outbound fetch to this service has no explicit timeout, so it
# falls back to Node undici's ~300s default headers timeout, after which the
# caller sees a generic "TypeError: fetch failed" with no indication it was
# a timeout. retry_on_rate_limit is used both for a single narrative
# write-up call AND for the main agent's whole .run() (which itself makes
# narrative calls that each retry on their own) — those budgets compound, so
# a wall-clock ceiling well under 300s is what actually keeps the combined
# retry time bounded, not just a per-call attempt count.
_MAX_RETRY_SECONDS = 90.0


async def retry_on_rate_limit(call: Callable[[], Awaitable[T]], max_attempts: int = 4) -> T:
    """Retries an awaitable-producing call whenever it raises a 429
    ModelHTTPError (exponential backoff — a per-minute token quota needs the
    retry window spread out) or a ModelAPIError (a stalled/timed-out
    connection to Azure, per AZURE_HTTP_TIMEOUT above — a short fixed retry
    is enough here since this isn't a quota issue, just a transient network
    hiccup). Re-raises anything else, or either of these once attempts/time
    are exhausted, immediately. Used both for the narrative write-up
    sub-agent's single model call and for the main resu agent's whole
    multi-step `.run()` — either exception can surface from any model
    request inside that run, and since nothing is mutated until `.run()`
    returns, retrying the entire call is safe.
    """
    deadline = time.monotonic() + _MAX_RETRY_SECONDS
    for attempt in range(max_attempts):
        try:
            return await call()
        except ModelHTTPError as e:
            if e.status_code != 429 or attempt == max_attempts - 1:
                raise
            # Per-minute token quota — a short fixed retry would likely hit
            # it again; this spreads retries out enough for the window to
            # roll over, but never past the wall-clock deadline above.
            delay = min((2**attempt) + random.uniform(0, 1), max(0.0, deadline - time.monotonic()))
            if delay <= 0:
                raise
            await asyncio.sleep(delay)
        except ModelAPIError:
            if attempt == max_attempts - 1:
                raise
            # A stalled connection timing out isn't a quota problem, so a
            # short fixed delay (not the growing backoff above) is enough —
            # still capped by the same overall deadline so this can't
            # compound indefinitely either.
            delay = min(5.0 + random.uniform(0, 2), max(0.0, deadline - time.monotonic()))
            if delay <= 0:
                raise
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")
