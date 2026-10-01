"""Agent-exclusive RunContext wrappers for the LinkedIn description agent.

Most of these are duplicated from agent/resu/tools.py rather than imported —
each agent folder is meant to stay portable/copy-paste per the new-agent
skill's cross-repo guidance, so resu doesn't import from anywhere else and
neither does this.
"""
from __future__ import annotations

import httpx
from pydantic_ai import RunContext

from .deps import LinkedinDeps


async def fetch_candidate_profile(ctx: RunContext[LinkedinDeps]) -> dict:
    """Fetch the candidate's resume prompt profile: template body plus personal
    facts (target role archetype, disqualifier keywords, location, experience
    cutoff, ATS match-score target). Call this before writing anything — it
    supplies the facts that make the LinkedIn draft specific to this candidate.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/resumes/profile")
        resp.raise_for_status()
        return resp.json()


_ENTRY_TYPE_MAP = {
    "workExperience": "WORK_EXPERIENCE",
    "education": "EDUCATION",
    "internships": "INTERNSHIP",
    "projects": "PROJECT",
}


async def fetch_structured_entries(ctx: RunContext[LinkedinDeps]) -> dict:
    """Fetch the candidate's curated background: work experience, education,
    internships, and projects, each with an `id` you MUST reuse as `entry_id`
    in your output so the saved bullets map back to the correct LinkedIn
    section, and each carrying its own `story` field — that entry's
    confirmed, per-entry narrative (already reviewed and approved by the
    user, so it is already correctly scoped to that one entry only). `story`
    is null for an entry with no confirmed story yet; write bullets for that
    entry using only facts clearly attributable to its own company/title/
    dates (e.g. from fetch_candidate_resume or fetch_connected_repo_readmes),
    never content from a different entry's story. Write bullets for EVERY
    entry returned here, regardless of its `required` flag — that flag only
    matters for the separate per-job resume agent, not this whole-profile
    LinkedIn draft, which covers the full background. Before finishing,
    verify your output's entry_bullets list has one item per id returned by
    this call, across all four categories — a missing id means an incomplete
    profile, not an intentional omission. Treat internships as part of work
    experience: merge them into the same chronological history as regular
    jobs rather than a separate section. Every project entry gets exactly 3
    bullets: one explaining the project/problem/tech stack, then two
    resume-style bullets each with a real quantitative impact value.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/entries")
        resp.raise_for_status()
        entries = resp.json()

        stories_resp = await client.get(f"{ctx.deps.api_base_url}/stories/confirmed")
        stories_resp.raise_for_status()
        stories_by_entry = {
            (s["entryType"], s["entryId"]): s["storyText"] for s in stories_resp.json()
        }

    for key, prisma_type in _ENTRY_TYPE_MAP.items():
        for entry in entries.get(key, []):
            entry["story"] = stories_by_entry.get((prisma_type, entry["id"]))

    return entries


async def fetch_candidate_resume(ctx: RunContext[LinkedinDeps]) -> str:
    """Fetch the full extracted text of every uploaded Resume file — a
    formatting/structure reference only, never the primary content source.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/resumes/files/text")
        resp.raise_for_status()
        return resp.json().get("text", "")


async def fetch_connected_repo_readmes(ctx: RunContext[LinkedinDeps]) -> list[dict]:
    """Fetch READMEs from the candidate's connected GitHub repos. Each entry is
    {repo, readme}. Supplementary material for project bullets. Empty list
    means no repos connected — not an error.
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


async def fetch_linkedin_source_material(ctx: RunContext[LinkedinDeps]) -> dict:
    """Determines which JD-sourcing stage applies right now and returns the
    correct tier of material, pre-selected — do NOT try to re-derive this
    yourself from a raw applications list; this tool does the staging so it's
    consistent every run. Always call this before writing the headline/about.

    Stages (checked in this order, based on real application data):
    1. No applications exist at all -> {stage: "archetype_only"}. Base the
       headline/about on the candidate's target role archetype alone (from
       fetch_candidate_profile) since there's no real job-market signal yet.
    2. Applications exist but none are marked APPLIED -> {stage: "all_jds",
       jds: [...]}. Synthesize a unified sense of the target role from every
       parsed job description across all saved applications (not yet applied
       to any of them, but the postings themselves are real signal).
    3. At least one application is APPLIED -> {stage: "applied_jds", jds:
       [...]}. Narrow to only the JDs of applications actually applied to —
       these represent roles the candidate is seriously pursuing, more
       reliable signal than saved-but-unapplied postings.
    4. Any APPLIED application has received a reply (a "callback") ->
       additionally includes callbackResumes: [{company, resumeContent}].
       These are resumes that provably worked — reuse their actual proven
       phrasing/bullet structure to reinforce the LinkedIn draft, on top of
       the applied_jds material.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.deps.api_base_url}/applications")
        resp.raise_for_status()
        applications = resp.json()

    if not applications:
        return {"stage": "archetype_only"}

    applied = [a for a in applications if a.get("status") == "APPLIED"]
    if not applied:
        jds = [a["jdText"] for a in applications if a.get("jdText")]
        return {"stage": "all_jds", "jds": jds}

    jds = [a["jdText"] for a in applied if a.get("jdText")]
    callback_apps = [a for a in applied if a.get("lastMessageReceivedDate")]

    result: dict = {"stage": "applied_jds", "jds": jds}
    if callback_apps:
        result["callbackResumes"] = [
            {"company": a["company"], "resumeContent": a.get("resumeContent") or ""}
            for a in callback_apps
            if a.get("resumeContent")
        ]
    return result
