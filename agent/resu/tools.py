"""Agent-exclusive RunContext wrappers for Resu.

Thin wrappers over the NestJS API's internal REST endpoints — the app has no
direct DB access of its own here (mirrors how a migrated Soma agent's tools call
shared data-access helpers rather than touching the DB directly).
"""
from __future__ import annotations

from typing import Literal

import httpx
from pydantic_ai import RunContext

from .deps import ResuDeps
from .html_text import html_to_text

# fetch_structured_entries returns camelCase group keys (workExperience,
# internships, projects, ...) and the model naturally echoes that casing
# back when it calls fetch_document_for_entry itself — but the NestJS
# /stories/document endpoint's entryType param is the Prisma enum
# (WORK_EXPERIENCE, etc.), same as agent.py's _fetch_all_documents already
# sends. Normalize here instead of relying on the model to use the right
# casing, since a plain string param gives it no structural guardrail.
_ENTRY_TYPE_TO_PRISMA = {
    "workExperience": "WORK_EXPERIENCE",
    "education": "EDUCATION",
    "internship": "INTERNSHIP",
    "internships": "INTERNSHIP",
    "project": "PROJECT",
    "projects": "PROJECT",
    # Already-correct Prisma enum values pass through unchanged.
    "WORK_EXPERIENCE": "WORK_EXPERIENCE",
    "EDUCATION": "EDUCATION",
    "INTERNSHIP": "INTERNSHIP",
    "PROJECT": "PROJECT",
}

# A Literal param (rather than a plain str) makes PydanticAI emit a JSON
# schema `enum` for this argument, so the model is structurally restricted
# to these exact values and can't send something like "work" (a plausible
# guess that isn't in _ENTRY_TYPE_TO_PRISMA above and would otherwise reach
# the API as an invalid entryType, 400, and crash the whole turn as an
# unhandled exception). Belt-and-suspenders with the dict above, which still
# runs for defense in depth and because the strict schema can't retroactively
# fix any call already in flight when this was added.
EntryTypeArg = Literal[
    "workExperience",
    "education",
    "internship",
    "internships",
    "project",
    "projects",
    "WORK_EXPERIENCE",
    "EDUCATION",
    "INTERNSHIP",
    "PROJECT",
]


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


async def fetch_document_for_entry(
    ctx: RunContext[ResuDeps], entry_type: EntryTypeArg, entry_id: str
) -> str | None:
    """Fetch the single detailed document for one specific entry — the
    user-generated, user-editable document covering every Stories/Resume
    file and connected GitHub repo pinned to this entry (see
    entry-document-editor.tsx). This is the authoritative content source for
    that entry specifically — never use one entry's document when writing a
    different entry's bullets, even if the subject matter looks similar.
    Returns None if the user hasn't generated a document for this entry yet
    (fall back to fetch_candidate_resume as a formatting reference only in
    that case, never invent content).

    entry_type must be exactly one of the group keys fetch_structured_entries
    returns (workExperience, education, internships, projects) or the
    equivalent SCREAMING_SNAKE_CASE form — not an abbreviation like "work".
    """
    prisma_entry_type = _ENTRY_TYPE_TO_PRISMA.get(entry_type)
    if prisma_entry_type is None:
        # Defense in depth for a value the Literal schema should already
        # have blocked (e.g. an older cached tool schema) — fail soft rather
        # than letting an invalid entryType reach the API as a 400 that
        # crashes the whole turn over one unresolved entry.
        return None
    # Plain cache read, no LLM call behind it — document generation only
    # happens when the user explicitly clicks Generate, never implicitly
    # here, so no LLM_CONCURRENCY/long timeout needed (unlike the old
    # narrative-fetch version of this tool).
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{ctx.deps.api_base_url}/stories/document",
            params={"entryType": prisma_entry_type, "entryId": entry_id},
        )
        resp.raise_for_status()
        doc = resp.json()
        return html_to_text(doc["contentHtml"]) if doc else None


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


async def fetch_candidate_resume(ctx: RunContext[ResuDeps]) -> str:
    """Fetch the full extracted text of every uploaded Resume file — used
    strictly as a formatting/structure reference, never as the primary
    content source (Stories is primary). Empty string means none uploaded.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/resumes/files/text")
        resp.raise_for_status()
        return resp.json().get("text", "")


async def fetch_company_job_descriptions(ctx: RunContext[ResuDeps], company: str) -> dict:
    """Fetch job descriptions for a specific company, for building one common
    resume shared across all of that company's applications — not a single-job
    tailored resume. Only call this for the company-resume workflow, not the
    per-application one.

    Prefers APPLIED applications for that company if any exist (stronger
    signal — roles actually pursued); falls back to all of that company's
    saved applications if none are applied yet. Returns
    {stage: "applied" | "all", jds: [...]}. Company match is case-sensitive,
    same convention used elsewhere in this app.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/applications")
        resp.raise_for_status()
        applications = resp.json()

    company_apps = [a for a in applications if a.get("company") == company]
    applied = [a for a in company_apps if a.get("status") == "APPLIED"]

    if applied:
        jds = [a["jdText"] for a in applied if a.get("jdText")]
        return {"stage": "applied", "jds": jds}

    jds = [a["jdText"] for a in company_apps if a.get("jdText")]
    return {"stage": "all", "jds": jds}


