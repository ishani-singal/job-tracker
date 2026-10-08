"""FastAPI wrapper exposing Resu over HTTP for the NestJS API to call.

Standalone-repo-only glue — in Soma this goes away entirely and run_turn() is
called in-process by whatever surfaces the "Generate Resume" action there.

Stateless by design: the NestJS API is the source of truth for session/message
persistence (Postgres, survives restarts of this process). Each call here is
"run one turn of this conversation" — takes the prior serialized message
history (or none, for a fresh session) and returns the new state.
"""
from __future__ import annotations

import os

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, TypeAdapter
from pydantic_ai.messages import ModelMessage

import httpx

from .agent import ResuTurnOutput, StructuredResume, _fetch_all_documents, run_company_turn, run_turn
from .definition import IDENTITY, INSTRUCTIONS, SOUL, build_profile_context

from cost_guard import BudgetExceededError

app = FastAPI(title="resu-agent")

# uvicorn doesn't route app loggers to its handlers by default, so the
# per-call cost lines (cost_guard.py) would otherwise never reach pm2 logs.
_cost_logger = logging.getLogger("llm_cost")
_cost_logger.setLevel(logging.INFO)
_cost_logger.handlers = logging.getLogger("uvicorn").handlers


@app.exception_handler(BudgetExceededError)
async def _budget_exceeded(_: Request, exc: BudgetExceededError) -> JSONResponse:
    return JSONResponse(status_code=402, content={"detail": str(exc)})

# The LinkedIn Description Agent shares this same process/app (see
# agent/linkedin/service.py) — mounted here rather than run as a separate
# uvicorn process, per the plan's "one Python process serves both agents".
from linkedin.service import router as linkedin_router  # noqa: E402
from .stories.service import router as stories_router
from .referral.service import router as referral_router

app.include_router(linkedin_router)
app.include_router(stories_router)
app.include_router(referral_router)

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")

_messages_adapter = TypeAdapter(list[ModelMessage])


class RunTurnRequest(BaseModel):
    application_id: str
    # JSON-encoded prior message history (from a previous turn's response),
    # or None to start a fresh session.
    message_history_json: str | None = None
    # The user's reply to the agent's last question; None on the first turn.
    user_reply: str | None = None
    # Lets the referral-style pipeline post live progress and the ATS score into the chat.
    session_id: str | None = None


class RunCompanyTurnRequest(BaseModel):
    company: str
    message_history_json: str | None = None
    user_reply: str | None = None


class RunTurnResponse(BaseModel):
    done: bool
    resume: StructuredResume | None
    question: str | None
    # JSON-encoded message history to pass back in on the next turn.
    message_history_json: str


class PromptPreviewResponse(BaseModel):
    prompt: str
    # The prefix (persona/instructions/facts/background) before the editable
    # process template — lets the UI show it read-only and edit just the
    # template portion without string-splitting the assembled prompt.
    prefix: str
    template_body: str


@app.post("/sessions/run-turn", response_model=RunTurnResponse)
async def run_turn_endpoint(body: RunTurnRequest) -> RunTurnResponse:
    history = (
        _messages_adapter.validate_json(body.message_history_json)
        if body.message_history_json
        else None
    )
    piped = None
    if history is None and body.session_id:
        from .referral.agent import run_application_resume

        piped = await run_application_resume(body.session_id, API_BASE_URL, body.application_id)
    if piped is not None:
        output, new_history = piped
    else:
        output, new_history = await run_turn(
            body.application_id, API_BASE_URL, history, body.user_reply
        )
    return RunTurnResponse(
        done=output.done,
        resume=output.resume,
        question=output.question,
        message_history_json=_messages_adapter.dump_json(new_history).decode("utf-8"),
    )


@app.post("/sessions/run-company-turn", response_model=RunTurnResponse)
async def run_company_turn_endpoint(body: RunCompanyTurnRequest) -> RunTurnResponse:
    history = (
        _messages_adapter.validate_json(body.message_history_json)
        if body.message_history_json
        else None
    )
    output, new_history = await run_company_turn(
        body.company, API_BASE_URL, history, body.user_reply
    )
    return RunTurnResponse(
        done=output.done,
        resume=output.resume,
        question=output.question,
        message_history_json=_messages_adapter.dump_json(new_history).decode("utf-8"),
    )


@app.get("/prompt-preview", response_model=PromptPreviewResponse)
async def prompt_preview() -> PromptPreviewResponse:
    """Returns the exact system prompt the agent would use right now — same
    SOUL/IDENTITY/INSTRUCTIONS plus the current profile facts and template body,
    assembled the identical way agent.py's system_prompt hook does it. Lets the
    web UI show, verbatim, what's actually driving generation.
    """
    async with httpx.AsyncClient() as client:
        profile_resp = await client.get(f"{API_BASE_URL}/resumes/profile")
        profile_resp.raise_for_status()
        profile = profile_resp.json()

        entries_resp = await client.get(f"{API_BASE_URL}/entries")
        entries_resp.raise_for_status()
        entries = entries_resp.json()

    # Same plain document lookup real generation uses (see agent.py) — a
    # cache read only, no LLM call triggered by viewing the preview.
    stories = await _fetch_all_documents(API_BASE_URL, entries)

    template_body = profile.get("templateBody", "")
    profile_context = build_profile_context(profile, entries, stories)
    prefix = f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n{profile_context}"
    # build_profile_context ends with "## Process template\n{templateBody}" —
    # strip the template body back off so `prefix` is everything before it.
    prefix = prefix[: len(prefix) - len(template_body)] if template_body else prefix

    return PromptPreviewResponse(
        prompt=f"{prefix}{template_body}",
        prefix=prefix,
        template_body=template_body,
    )
