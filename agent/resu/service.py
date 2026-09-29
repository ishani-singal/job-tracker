"""FastAPI wrapper exposing Resu over HTTP for the NestJS API to call.

Standalone-repo-only glue — in Soma this goes away entirely and generate_resume()
is called in-process by whatever surfaces the "Generate Resume" action there.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from pydantic import BaseModel

import httpx

from .agent import generate_resume
from .definition import IDENTITY, INSTRUCTIONS, SOUL, build_profile_context

app = FastAPI(title="resu-agent")

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")


class GenerateResumeRequest(BaseModel):
    application_id: str


class GenerateResumeResponse(BaseModel):
    resume: str


class PromptPreviewResponse(BaseModel):
    prompt: str


@app.post("/generate-resume", response_model=GenerateResumeResponse)
async def generate_resume_endpoint(body: GenerateResumeRequest) -> GenerateResumeResponse:
    resume = await generate_resume(body.application_id, API_BASE_URL)
    return GenerateResumeResponse(resume=resume)


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

    prompt = (
        f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
        f"{build_profile_context(profile, entries)}"
    )
    return PromptPreviewResponse(prompt=prompt)
