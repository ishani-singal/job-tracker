"""Resu's Agent instance + entry point.

Multi-turn: each call to run_turn() is one full agent run (it always finishes —
PydanticAI has no mid-execution pause), but the agent's *structured output*
tells the caller whether it's actually done (resume finalized) or needs the
user to answer something before it can finish. The caller persists
message_history and, on a reply, calls run_turn() again with that history so
the model continues the same reasoning thread rather than starting over.
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider

from .deps import ResuDeps
from .definition import IDENTITY, INSTRUCTIONS, SOUL, TOOLS, build_profile_context

_model = OpenAIChatModel(
    os.environ.get("AZURE_LLM_DEPLOYMENT_NAME", "gpt-4.1"),
    provider=AzureProvider(
        azure_endpoint=os.environ["AZURE_LLM_ENDPOINT"],
        api_key=os.environ["AZURE_LLM_API_KEY"],
        api_version=os.environ.get("AZURE_LLM_API_VERSION", "2024-12-01-preview"),
    ),
)


class ResumeEntry(BaseModel):
    """One work/education/project/paper entry — mirrors shared-types'
    StructuredResumeEntry exactly (field names and nullability) since this is
    serialized straight to JSON and read by the TS renderer unchanged.
    """

    name: str
    subtitle: str | None = None
    location: str | None = None
    dateRange: str | None = None
    bullets: list[str]


class ResumeSection(BaseModel):
    """Mirrors shared-types' StructuredResumeSection."""

    heading: str
    kind: str  # 'work' | 'education' | 'project' | 'paper'
    entries: list[ResumeEntry]


class StructuredResume(BaseModel):
    """Mirrors shared-types' StructuredResume — this exact shape is what
    gets JSON-serialized into SessionMessage.content and, on accept, into
    Application.resumeContent / CompanyResume.resumeContent, where the
    one-page-fit PDF renderer (structured-resume-pdf.ts) expects it.
    """

    contactLine: str
    sections: list[ResumeSection]


class ResuTurnOutput(BaseModel):
    """What the agent produces each turn. `done=False` means `question` holds
    something the user must answer before the resume can be finalized (e.g.
    the Step 7 clarifying questions, or a disqualifier-keyword stop). `done=True`
    means `resume` holds the finished, ready-to-save structured resume.
    """

    done: bool
    resume: StructuredResume | None = None
    question: str | None = None


_BASE_SYSTEM_PROMPT = (
    f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
    "Respond with structured output every turn: set done=true and put the "
    "complete finished resume in `resume` as a StructuredResume object "
    "(contactLine + sections, each section holding heading/kind/entries, "
    "each entry holding name/subtitle/location/dateRange/bullets) once "
    "you've gone through the full process template with no open questions. "
    "Do not put a name, job title, or 'open to remote' in contactLine — it "
    "is rendered separately above the contact line; contactLine holds only "
    "the exact value given to you below under 'Contact line'. Every bullet "
    "string in `entries[].bullets` must be plain text with no leading "
    "bullet character — the renderer adds its own. If you still need "
    "something from the user (answers to Step 7 questions, or you hit a "
    "disqualifier stop and want to confirm before continuing), set "
    "done=false, leave `resume` unset, and put exactly one clear question "
    "in `question` — the user will reply and you will continue from there "
    "in the next turn.\n\n"
    "Each section's `kind` must be exactly one of 'work', 'education', "
    "'project', or 'paper' — pick the closest match (e.g. internships are "
    "'work'). The process template's instruction to bold newly-incorporated "
    "keywords refers to markdown **like this** inside a bullet string — "
    "keep that convention; the renderer strips or renders it, bullets "
    "should not otherwise contain markdown."
)

resu_agent = Agent(
    model=_model,
    deps_type=ResuDeps,
    output_type=ResuTurnOutput,
    system_prompt=_BASE_SYSTEM_PROMPT,
    tools=TOOLS,
)


async def _fetch_all_narratives(api_base_url: str, entries: dict) -> list[dict]:
    """Fetches every entry's live-extracted narrative(s) up front, in
    parallel, so build_profile_context can inline each one directly rather
    than the model having to call a per-entry tool itself. Each source
    tagged to an entry is its own narrative string (see
    StoriesService.getNarrativesForEntry) — multiple sources for the same
    entry are joined here into one combined narrative for that entry's
    prompt line, since the model only needs one Story per entry, not a list.
    """
    jobs: list[tuple[str, str, str]] = []  # (prisma_entry_type, entry_id, label)
    for e in entries.get("workExperience", []):
        jobs.append(("WORK_EXPERIENCE", e["id"], f"{e['company']} — {e.get('title') or 'Work Experience'}"))
    for e in entries.get("education", []):
        jobs.append(("EDUCATION", e["id"], f"{e['school']} — {e.get('degree') or 'Education'}"))
    for e in entries.get("internships", []):
        jobs.append(("INTERNSHIP", e["id"], f"{e['company']} — {e.get('title') or 'Internship'}"))
    for e in entries.get("projects", []):
        jobs.append(("PROJECT", e["id"], e["name"]))

    async def fetch_one(entry_type: str, entry_id: str, label: str) -> dict | None:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.get(
                f"{api_base_url}/stories/narratives",
                params={"entryType": entry_type, "entryId": entry_id, "entryLabel": label},
            )
            resp.raise_for_status()
            narratives = resp.json()
        if not narratives:
            return None
        return {"entryType": entry_type, "entryId": entry_id, "storyText": "\n\n".join(narratives)}

    results = await asyncio.gather(*(fetch_one(*job) for job in jobs))
    return [r for r in results if r]


@resu_agent.system_prompt
async def _inject_profile(ctx: RunContext[ResuDeps]) -> str:
    """Appends the candidate's profile facts + structured entries + process
    template to the base prompt on every run, so the model has them from its
    very first turn instead of needing to call the fetch tools itself first.
    """
    async with httpx.AsyncClient() as client:
        profile_resp = await client.get(f"{ctx.deps.api_base_url}/resumes/profile")
        profile_resp.raise_for_status()
        profile = profile_resp.json()

        entries_resp = await client.get(f"{ctx.deps.api_base_url}/entries")
        entries_resp.raise_for_status()
        entries = entries_resp.json()

    stories = await _fetch_all_narratives(ctx.deps.api_base_url, entries)

    return build_profile_context(profile, entries, stories)


async def run_turn(
    application_id: str,
    api_base_url: str,
    message_history: list[ModelMessage] | None,
    user_reply: str | None,
) -> tuple[ResuTurnOutput, list[ModelMessage]]:
    """Runs one turn of the generation conversation.

    First turn: message_history=None, user_reply=None — starts fresh.
    Later turns: message_history from the prior turn's all_messages(),
    user_reply is what the user typed in response to the agent's question.
    Returns (output, updated_message_history) — the caller persists both.
    """
    deps = ResuDeps(api_base_url=api_base_url)
    prompt = (
        user_reply
        if message_history
        else f"Generate a tailored resume for application {application_id}."
    )
    result = await resu_agent.run(
        prompt,
        deps=deps,
        message_history=message_history,
    )
    return result.output, result.all_messages()


async def run_company_turn(
    company: str,
    api_base_url: str,
    message_history: list[ModelMessage] | None,
    user_reply: str | None,
) -> tuple[ResuTurnOutput, list[ModelMessage]]:
    """Same as run_turn, but for the company-resume workflow: one common
    resume built from all of a company's applications rather than one
    application. Uses fetch_company_job_descriptions instead of
    fetch_job_description.
    """
    deps = ResuDeps(api_base_url=api_base_url)
    prompt = (
        user_reply
        if message_history
        else f"Generate one common resume covering all applications at {company}."
    )
    result = await resu_agent.run(
        prompt,
        deps=deps,
        message_history=message_history,
    )
    return result.output, result.all_messages()
