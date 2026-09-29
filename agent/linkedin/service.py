"""FastAPI router for the LinkedIn Description Agent — mounted onto the same
app instance as agent/resu/service.py (one Python process serves both agents;
see main.py). Stateless, same pattern as resu: NestJS's SessionsService is the
source of truth for persistence, this just runs one turn per call.
"""
from __future__ import annotations

import os

from fastapi import APIRouter
from pydantic import BaseModel, TypeAdapter
from pydantic_ai.messages import ModelMessage

from .agent import run_turn
from .definition import IDENTITY, INSTRUCTIONS, SOUL

router = APIRouter(prefix="/linkedin", tags=["linkedin"])

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")

_messages_adapter = TypeAdapter(list[ModelMessage])


class LinkedinRunTurnRequest(BaseModel):
    message_history_json: str | None = None
    user_reply: str | None = None


class LinkedinEntryBulletsOut(BaseModel):
    entry_type: str
    entry_id: str
    bullets: list[str]


class LinkedinRunTurnResponse(BaseModel):
    done: bool
    headline: str | None
    about: str | None
    entry_bullets: list[LinkedinEntryBulletsOut] | None
    question: str | None
    message_history_json: str


class LinkedinPromptPreviewResponse(BaseModel):
    prompt: str


@router.post("/run-turn", response_model=LinkedinRunTurnResponse)
async def run_turn_endpoint(body: LinkedinRunTurnRequest) -> LinkedinRunTurnResponse:
    history = (
        _messages_adapter.validate_json(body.message_history_json)
        if body.message_history_json
        else None
    )
    output, new_history = await run_turn(API_BASE_URL, history, body.user_reply)
    return LinkedinRunTurnResponse(
        done=output.done,
        headline=output.headline,
        about=output.about,
        entry_bullets=[
            LinkedinEntryBulletsOut(**b.model_dump()) for b in (output.entry_bullets or [])
        ]
        if output.entry_bullets
        else None,
        question=output.question,
        message_history_json=_messages_adapter.dump_json(new_history).decode("utf-8"),
    )


@router.get("/prompt-preview", response_model=LinkedinPromptPreviewResponse)
async def prompt_preview() -> LinkedinPromptPreviewResponse:
    """Returns the fixed SOUL/IDENTITY/INSTRUCTIONS prompt — unlike Resu's
    preview, there's no per-candidate templateBody here to separate out (the
    LinkedIn agent has no editable process template yet), so this is just the
    static persona/instructions text.
    """
    return LinkedinPromptPreviewResponse(prompt=f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}")
