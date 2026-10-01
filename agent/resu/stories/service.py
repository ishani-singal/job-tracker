"""FastAPI router for per-entry detailed document generation — mounted onto
the same app instance as agent/resu/service.py (see main.py). Called by
NestJS's SessionsService as a chat-style session, one per "Generate" click
on an entry (ENTRY_DOCUMENT scope) — not a plain stateless request/response
like the old /stories/extract-narrative. The document itself (not this
endpoint) is what's persisted, in Postgres's EntryDocument table, and only
once the user explicitly Accepts the session.

Stateless per-call (same convention as /sessions/run-turn in
agent/resu/service.py) — NestJS is the source of truth for session/message
persistence; each call here is "run one turn," given whatever the caller
has gathered so far (raw sources don't change turn to turn, only
user_reply/already_asked do).
"""
from __future__ import annotations

import os

from fastapi import APIRouter
from pydantic import BaseModel

from .agent import RawSource, run_entry_document_turn

router = APIRouter(prefix="/stories", tags=["stories"])

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")


class RunDocumentTurnRequest(BaseModel):
    session_id: str
    existing_document_html: str
    raw_sources: list[RawSource]
    entry_label: str
    user_reply: str | None = None
    already_asked: bool = False


class RunDocumentTurnResponse(BaseModel):
    done: bool
    content_html: str | None = None
    question: str | None = None


@router.post("/run-turn", response_model=RunDocumentTurnResponse)
async def run_document_turn_endpoint(body: RunDocumentTurnRequest) -> RunDocumentTurnResponse:
    done, content_html, question = await run_entry_document_turn(
        body.session_id,
        API_BASE_URL,
        body.existing_document_html,
        body.raw_sources,
        body.entry_label,
        body.user_reply,
        body.already_asked,
    )
    return RunDocumentTurnResponse(done=done, content_html=content_html, question=question)
