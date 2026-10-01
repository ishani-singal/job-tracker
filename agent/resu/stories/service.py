"""FastAPI router for the Story Extraction Agent — mounted onto the same app
instance as agent/resu/service.py (see main.py). Stateless, same pattern as
resu/linkedin: NestJS's SessionsService persists message_history/messages
between turns; each call here just runs one turn of one document's
extraction conversation and returns the new state.
"""
from __future__ import annotations

import os
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, TypeAdapter
from pydantic_ai.messages import ModelMessage

from .agent import StoryCandidateOut, run_turn

router = APIRouter(prefix="/stories", tags=["stories"])

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")

_messages_adapter = TypeAdapter(list[ModelMessage])


class RunTurnRequest(BaseModel):
    # Only required/used on the first turn (message_history_json is None) —
    # ignored on later turns, where the conversation already has this
    # context baked into message_history.
    raw_text: str | None = None
    source_type: Literal["story_file", "resume_file", "github_repo"] | None = None
    source_label: str | None = None
    entries: dict | None = None
    # Set when the user picked a background category for this document at
    # upload time — the entries dict has already been narrowed to only that
    # category by the caller, so this is passed through mainly so the
    # instructions can tell the model the scoping is a hard boundary already
    # enforced, not something left to the model to re-derive.
    hint_entry_type: Literal["workExperience", "education", "internship", "project", "paper"] | None = None
    # Set when the user picked one specific entry (e.g. one particular Work
    # Experience row, not just the category) for this document at upload
    # time — the entries dict has already been narrowed to just that one
    # entry, so the whole document is pinned to it.
    hint_entry_id: str | None = None
    # JSON-encoded prior message history (from a previous turn's response),
    # or None to start a fresh session.
    message_history_json: str | None = None
    # The user's reply to the agent's last question; None on the first turn.
    user_reply: str | None = None


class RunTurnResponse(BaseModel):
    done: bool
    candidates: list[StoryCandidateOut] | None
    question: str | None
    message_history_json: str


@router.post("/run-turn", response_model=RunTurnResponse)
async def run_turn_endpoint(body: RunTurnRequest) -> RunTurnResponse:
    history = (
        _messages_adapter.validate_json(body.message_history_json)
        if body.message_history_json
        else None
    )
    output, new_history = await run_turn(
        raw_text=body.raw_text or "",
        source_type=body.source_type or "story_file",
        source_label=body.source_label or "",
        entries=body.entries or {},
        api_base_url=API_BASE_URL,
        hint_entry_type=body.hint_entry_type,
        hint_entry_id=body.hint_entry_id,
        message_history=history,
        user_reply=body.user_reply,
    )
    return RunTurnResponse(
        done=output.done,
        candidates=output.candidates,
        question=output.question,
        message_history_json=_messages_adapter.dump_json(new_history).decode("utf-8"),
    )
