"""Per-LLM-call cost logging + spend blockers for every agent in this process.

CostGuardModel wraps an agent's model and sits on the single choke point every
individual LLM request passes through, so it can log each call's cost (Soma's
agent/__init__.py log_run only logs per-run token totals, no cost) and refuse
a request before it is made once a cap is hit:

  - LLM_RUN_BUDGET_USD   (default 1.00)  cap on one run_scope(...) block
  - daily cap + per-model prices (input / cached input / output, per 1M tokens)
    come from the API's GET /llm-calls/config (edited on the /llm-usage page),
    cached for 30s. If the API is unreachable, falls back to LLM_DAILY_BUDGET_USD
    (default 5.00), the built-in gpt-4.1 price and the day total kept in
    .llm_spend.json.

Every call is also POSTed to the API's /llm-calls (best-effort) for the page.
"""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import os
import threading
import time
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import httpx
from pydantic_ai.messages import ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.wrapper import WrapperModel

logger = logging.getLogger("llm_cost")

_PRICES = {"gpt-4.1": (2.00, 0.50, 8.00)}  # input, cached input, output
_SPEND_FILE = Path(__file__).parent / ".llm_spend.json"
_WARN_FRACTION = 0.8

_lock = threading.Lock()
_pending: set[asyncio.Task] = set()  # keeps fire-and-forget posts from being GC'd
_run_total: contextvars.ContextVar[list[float] | None] = contextvars.ContextVar("llm_run_total", default=None)


class BudgetExceededError(Exception):
    """Raised before an LLM request when a run or daily spend cap is reached."""


def _limit(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


_API_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")
_CONFIG_TTL = 30.0
_config: dict | None = None
_config_at = 0.0


async def _get_config() -> dict | None:
    """The API's {dailyBudgetUsd, todayUsd, prices}, cached; None if unreachable."""
    global _config, _config_at
    if _config is not None and time.monotonic() - _config_at < _CONFIG_TTL:
        return _config
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{_API_URL}/llm-calls/config")
            resp.raise_for_status()
            _config, _config_at = resp.json(), time.monotonic()
    except Exception:
        logger.warning("llm-cost: could not fetch config from API, using fallback")
        _config = None
    return _config


def _prices(config: dict | None, model: str) -> tuple[float, float, float] | None:
    """(input, cached input, output) USD per 1M tokens, or None if unpriced."""
    for row in (config or {}).get("prices", []):
        if row["model"] == model:
            return row["inputPer1M"], row["cachedInputPer1M"], row["outputPer1M"]
    if config is None and model in _PRICES:
        return _PRICES[model]
    return None


async def _post_call(record: dict) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{_API_URL}/llm-calls", json=record)
    except Exception:
        logger.warning("llm-cost: failed to record call in API")


def _log_tools(agent: str, messages, response) -> tuple[int, str]:
    """Logs the tool calls this response makes and the sizes of the tool results
    that were just sent to the model (Soma's log_run tool-call/tool-return lines),
    so a large payload or a chatty one-tool-per-step loop is visible. Returns
    (step number, short hash of the first request's content) — a changed hash
    between calls of one run means the cached prompt prefix was altered.
    """
    step, prefix = 0, "?"
    try:
        step = sum(isinstance(m, ModelResponse) for m in messages) + 1
        if messages and isinstance(messages[0], ModelRequest):
            prefix = hashlib.md5(str(messages[0].parts).encode()).hexdigest()[:8]
        if messages and isinstance(messages[-1], ModelRequest):
            for part in messages[-1].parts:
                if isinstance(part, ToolReturnPart):
                    logger.info(
                        "tool-return: agent=%s step=%d tool=%s result_len=%d",
                        agent, step, part.tool_name, len(str(part.content)),
                    )
        for part in response.parts:
            if isinstance(part, ToolCallPart):
                logger.info(
                    "tool-call: agent=%s step=%d tool=%s args_len=%d",
                    agent, step, part.tool_name, len(str(part.args or "")),
                )
    except Exception:
        logger.exception("llm-cost: tool logging failed")
    return step, prefix


def _day_total() -> float:
    try:
        data = json.loads(_SPEND_FILE.read_text())
    except Exception:
        return 0.0
    return float(data.get(date.today().isoformat(), 0.0))


def _add_day(cost: float) -> float:
    total = _day_total() + cost
    try:
        _SPEND_FILE.write_text(json.dumps({date.today().isoformat(): total}))
    except Exception:
        logger.exception("llm-cost: failed to persist daily spend")
    return total


@contextmanager
def run_scope():
    """Starts a fresh per-run spend tally for the calls made inside the block."""
    token = _run_total.set([0.0])
    try:
        yield
    finally:
        _run_total.reset(token)


class CostGuardModel(WrapperModel):
    def __init__(self, wrapped, agent: str):
        super().__init__(wrapped)
        self.agent_name = agent

    async def request(self, messages, model_settings, model_request_parameters):
        config = await _get_config()
        run_limit = _limit("LLM_RUN_BUDGET_USD", 1.00)
        if config is not None:
            day_limit = config["dailyBudgetUsd"]
            day = config["todayUsd"]
        else:
            day_limit = _limit("LLM_DAILY_BUDGET_USD", 5.00)
            with _lock:
                day = _day_total()
        tally = _run_total.get()
        run = tally[0] if tally else 0.0
        if day >= day_limit:
            raise BudgetExceededError(f"Daily LLM budget reached: ${day:.4f} spent of ${day_limit:.2f}")
        if run >= run_limit:
            raise BudgetExceededError(f"Per-run LLM budget reached: ${run:.4f} spent of ${run_limit:.2f}")

        response = await self.wrapped.request(messages, model_settings, model_request_parameters)

        step, prefix = _log_tools(self.agent_name, messages, response)
        u = response.usage
        in_tok, out_tok = u.input_tokens or 0, u.output_tokens or 0
        cached = u.cache_read_tokens or 0
        model = self.wrapped.model_name
        prices = _prices(config, model)
        if prices is None:
            logger.warning("llm-cost: no price set for model=%s, counting as $0", model)
            prices = (0.0, 0.0, 0.0)
        p_in, p_cached, p_out = prices
        in_cost = ((in_tok - cached) * p_in + cached * p_cached) / 1_000_000
        out_cost = out_tok * p_out / 1_000_000
        cost = in_cost + out_cost
        if tally is not None:
            tally[0] += cost
            run = tally[0]
        else:
            run += cost
        with _lock:
            file_day = _add_day(cost)
        day = day + cost if config is not None else file_day
        logger.info(
            "llm-call: agent=%s step=%d prefix=%s model=%s in=%d cached=%d out=%d cost=$%.4f (in $%.4f out $%.4f) run_total=$%.4f day_total=$%.4f",
            self.agent_name, step, prefix, model, in_tok, cached, out_tok, cost, in_cost, out_cost, run, day,
        )
        if run >= run_limit * _WARN_FRACTION or day >= day_limit * _WARN_FRACTION:
            logger.warning(
                "llm-budget: nearing cap agent=%s run=$%.4f/%.2f day=$%.4f/%.2f",
                self.agent_name, run, run_limit, day, day_limit,
            )
        if config is not None:
            # Keep the cached daily total current between refreshes so a burst
            # of calls can't overshoot the cap by a whole refresh interval.
            config["todayUsd"] = day
        _pending.add(task := asyncio.create_task(_post_call({
            "agent": self.agent_name, "model": model,
            "inputTokens": in_tok, "cachedTokens": cached, "outputTokens": out_tok,
            "inputCostUsd": in_cost, "outputCostUsd": out_cost,
        })))
        task.add_done_callback(_pending.discard)
        return response
