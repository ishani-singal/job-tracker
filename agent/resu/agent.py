"""Resu's Agent instance + entry point.

Internal/background-style agent (no user-facing chat, no streaming) — called
synchronously by the "Generate Resume" button via the FastAPI service in
service.py. Entry point shape matches the new-agent skill's guidance for
internal agents: a single async run function, not stream_in_chat.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

import httpx
from pydantic_ai import Agent, RunContext
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

_BASE_SYSTEM_PROMPT = f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}"

resu_agent = Agent(
    model=_model,
    deps_type=ResuDeps,
    system_prompt=_BASE_SYSTEM_PROMPT,
    tools=TOOLS,
)


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

    return build_profile_context(profile, entries)


async def generate_resume(application_id: str, api_base_url: str) -> str:
    """One-shot: generate a tailored resume for the given application id."""
    deps = ResuDeps(api_base_url=api_base_url)
    result = await resu_agent.run(
        f"Generate a tailored resume for application {application_id}.",
        deps=deps,
    )
    return result.output
