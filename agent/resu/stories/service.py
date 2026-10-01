"""FastAPI router for live narrative extraction — mounted onto the same app
instance as agent/resu/service.py (see main.py). Called by NestJS's
StoriesService the first time a resume generation needs a given entry's
narrative from a given source; the result is cached by the caller
(ExtractedNarrative), so this endpoint only actually runs the LLM again
when that source's raw text changes. Stateless, one-shot — no chat, no
message history, unlike the old /stories/run-turn.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .agent import extract_narrative

router = APIRouter(prefix="/stories", tags=["stories"])


class ExtractNarrativeRequest(BaseModel):
    raw_text: str
    entry_label: str


class ExtractNarrativeResponse(BaseModel):
    narrative_text: str


@router.post("/extract-narrative", response_model=ExtractNarrativeResponse)
async def extract_narrative_endpoint(body: ExtractNarrativeRequest) -> ExtractNarrativeResponse:
    narrative_text = await extract_narrative(body.raw_text, body.entry_label)
    return ExtractNarrativeResponse(narrative_text=narrative_text)
