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
from types import SimpleNamespace

from dotenv import load_dotenv

load_dotenv()

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider

from cost_guard import CostGuardModel, run_scope

from .deps import ResuDeps
from .definition import IDENTITY, INSTRUCTIONS, SOUL, TOOLS, build_profile_context
from .html_text import html_to_text
from .tools import fetch_company_job_descriptions, fetch_job_description
from .rate_limit import AZURE_HTTP_TIMEOUT, retry_on_rate_limit

# Resume generation can run on its own deployment (e.g. gpt-5.1) while the other
# agents stay on AZURE_LLM_*; each RESU_LLM_* var falls back to its AZURE_LLM_*
# counterpart when unset. The deployment name must match a row in the
# /llm-usage price table or its calls are costed at $0.
def _resu_env(name: str, default: str | None = None) -> str:
    return os.environ.get(f"RESU_LLM_{name}") or os.environ.get(f"AZURE_LLM_{name}") or default or ""


_model = CostGuardModel(
    OpenAIChatModel(
        _resu_env("DEPLOYMENT_NAME", "gpt-4.1"),
        provider=AzureProvider(
            azure_endpoint=_resu_env("ENDPOINT"),
            api_key=_resu_env("API_KEY"),
            api_version=_resu_env("API_VERSION", "2024-12-01-preview"),
            http_client=httpx.AsyncClient(timeout=AZURE_HTTP_TIMEOUT),
        ),
    ),
    agent="resu",
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
    url: str | None = None


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
    "each entry holding name/subtitle/location/dateRange/bullets/url) once "
    "you've gone through the full process template with no open questions. "
    "A project entry's own line in the background below may carry a "
    "'[LINK: <url>]' tag — if present, copy that URL verbatim into that "
    "entry's `url` field; if absent, leave `url` unset (null). Never "
    "construct or guess a URL yourself — only ever copy one from a "
    "[LINK: ...] tag. Work/education/internship entries have no `url`; "
    "leave it unset for those.\n\n"
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


async def _fetch_all_documents(api_base_url: str, entries: dict) -> list[dict]:
    """Fetches every entry's single detailed document up front, in parallel,
    so build_profile_context can inline each one directly rather than the
    model having to call a per-entry tool itself. Plain cache reads — no LLM
    call happens here at all; generation never triggers document generation,
    the user must have clicked "Generate" on that entry beforehand (see
    entry-document-editor.tsx). That's why this needs neither
    LLM_CONCURRENCY nor a long timeout, unlike the old narrative-fetch
    version of this function.
    """
    jobs: list[tuple[str, str]] = []  # (prisma_entry_type, entry_id)
    for e in entries.get("workExperience", []):
        jobs.append(("WORK_EXPERIENCE", e["id"]))
    for e in entries.get("education", []):
        jobs.append(("EDUCATION", e["id"]))
    for e in entries.get("internships", []):
        jobs.append(("INTERNSHIP", e["id"]))
    for e in entries.get("projects", []):
        jobs.append(("PROJECT", e["id"]))

    async def fetch_one(entry_type: str, entry_id: str) -> dict | None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{api_base_url}/stories/document",
                params={"entryType": entry_type, "entryId": entry_id},
            )
            resp.raise_for_status()
            doc = resp.json()
        if not doc or not doc.get("contentHtml"):
            return None
        return {"entryType": entry_type, "entryId": entry_id, "storyText": html_to_text(doc["contentHtml"])}

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

    stories = await _fetch_all_documents(ctx.deps.api_base_url, entries)

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
    if message_history:
        prompt = user_reply
    else:
        # The JD goes in the user message (after the stable system-prompt
        # prefix, so prompt caching still hits) instead of costing a tool
        # round trip that re-sends the whole ~50k-token context.
        jd = await fetch_job_description(SimpleNamespace(deps=deps), application_id)
        prompt = (
            f"Generate a tailored resume for application {application_id}.\n\n"
            f"## Job description\n{jd or '[empty - no JD saved for this application]'}"
        )
    # A 429 can surface from any model request inside this multi-step run
    # (not just the narrative sub-agent's own calls), and nothing is
    # persisted until .run() returns, so retrying the whole call is safe.
    with run_scope():
        result = await retry_on_rate_limit(
            lambda: resu_agent.run(prompt, deps=deps, message_history=message_history)
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
    if message_history:
        prompt = user_reply
    else:
        found = await fetch_company_job_descriptions(SimpleNamespace(deps=deps), company)
        jds = "\n\n---\n\n".join(found["jds"]) or "[none saved]"
        prompt = (
            f"Generate one common resume covering all applications at {company}.\n\n"
            f"## Job descriptions ({found['stage']} applications)\n{jds}"
        )
    with run_scope():
        result = await retry_on_rate_limit(
            lambda: resu_agent.run(prompt, deps=deps, message_history=message_history)
        )
    return result.output, result.all_messages()
