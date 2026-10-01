"""FastAPI router for the Story Extraction Agent — mounted onto the same app
instance as agent/resu/service.py (see main.py). Stateless: NestJS's
StoriesService calls this once per source file/repo and persists the
returned candidates itself.
"""
from __future__ import annotations

import os
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from .agent import StoryCandidateOut, extract_stories

router = APIRouter(prefix="/stories", tags=["stories"])

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")


class ExtractRequest(BaseModel):
    raw_text: str
    source_type: Literal["story_file", "resume_file", "github_repo"]
    source_label: str
    entries: dict


class ExtractResponse(BaseModel):
    candidates: list[StoryCandidateOut]


@router.post("/extract", response_model=ExtractResponse)
async def extract_endpoint(body: ExtractRequest) -> ExtractResponse:
    output = await extract_stories(
        raw_text=body.raw_text,
        source_type=body.source_type,
        source_label=body.source_label,
        entries=body.entries,
        api_base_url=API_BASE_URL,
    )
    return ExtractResponse(candidates=output.candidates)
