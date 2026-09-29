"""Agent-exclusive RunContext wrappers for Resu.

Thin wrappers over the NestJS API's internal REST endpoints — the app has no
direct DB access of its own here (mirrors how a migrated Soma agent's tools call
shared data-access helpers rather than touching the DB directly).
"""
from __future__ import annotations

import httpx
from pydantic_ai import RunContext

from .deps import ResuDeps


async def fetch_job_description(ctx: RunContext[ResuDeps], application_id: str) -> str:
    """Fetch the job description text for a given application.

    Call this first to get the JD to tailor the resume against. Returns the raw
    jdText field; if empty, the application has no parsed/entered JD yet.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/applications/{application_id}")
        resp.raise_for_status()
        data = resp.json()
        return data.get("jdText") or ""


async def fetch_candidate_profile(ctx: RunContext[ResuDeps]) -> dict:
    """Fetch the candidate's resume prompt profile: template body plus personal
    facts (target role archetype, disqualifier keywords, location, experience
    cutoff, ATS match-score target). Call this before writing any resume
    content — it supplies both the process instructions and the facts that
    make bullets specific to this candidate rather than generic.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/resumes/profile")
        resp.raise_for_status()
        return resp.json()


async def fetch_structured_entries(ctx: RunContext[ResuDeps]) -> dict:
    """Fetch the candidate's curated background: work experience, education,
    internships, and projects, each entry flagged `required` (True) or not.

    Required entries MUST appear in the generated resume regardless of the
    JD. Non-required entries are optional — include one only if it's actually
    relevant to the specific JD being tailored for right now (e.g. a project
    whose tech stack or domain matches what the JD asks for); otherwise leave
    it out rather than padding the resume with irrelevant history.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/entries")
        resp.raise_for_status()
        return resp.json()


async def fetch_candidate_stories(ctx: RunContext[ResuDeps]) -> list[dict]:
    """List uploaded Stories files (detailed work-experience narratives) — the
    primary source of truth for resume content. Returns filename/id metadata;
    fetch actual file bytes via fetch_file_content if the model needs raw text
    and the API doesn't already inline it.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/resumes/stories")
        resp.raise_for_status()
        return resp.json()


async def fetch_candidate_resume(ctx: RunContext[ResuDeps]) -> list[dict]:
    """List uploaded Resume files — used strictly as a formatting/structure
    reference, never as the primary content source (Stories is primary).
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/resumes/files")
        resp.raise_for_status()
        return resp.json()


async def fetch_connected_repo_readmes(ctx: RunContext[ResuDeps]) -> list[dict]:
    """Fetch READMEs from the candidate's connected GitHub repos (configured in
    Settings). Each entry is {repo, readme}. Treat this as supplementary Stories
    material — real project descriptions, tech stack, and scope straight from
    the source — useful for filling in project/internship bullets when the
    uploaded Stories file doesn't cover a specific project in enough depth.
    Returns an empty list if no GitHub account is connected or no repos are
    selected — that's not an error, just means there's nothing extra here.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/github/repos/connected")
        resp.raise_for_status()
        connected = resp.json()
        if not connected:
            return []

        readme_resp = await client.get(f"{ctx.deps.api_base_url}/github/readmes")
        if readme_resp.status_code != 200:
            return []
        return readme_resp.json()
