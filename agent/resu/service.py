"""FastAPI wrapper exposing Resu over HTTP for the NestJS API to call.

Standalone-repo-only glue — in Soma this goes away entirely and generate_resume()
is called in-process by whatever surfaces the "Generate Resume" action there.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from pydantic import BaseModel

from .agent import generate_resume

app = FastAPI(title="resu-agent")

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")


class GenerateResumeRequest(BaseModel):
    application_id: str


class GenerateResumeResponse(BaseModel):
    resume: str


@app.post("/generate-resume", response_model=GenerateResumeResponse)
async def generate_resume_endpoint(body: GenerateResumeRequest) -> GenerateResumeResponse:
    resume = await generate_resume(body.application_id, API_BASE_URL)
    return GenerateResumeResponse(resume=resume)
