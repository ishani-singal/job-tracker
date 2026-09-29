"""Resu's Agent instance + entry point.

Multi-turn: each call to run_turn() is one full agent run (it always finishes —
PydanticAI has no mid-execution pause), but the agent's *structured output*
tells the caller whether it's actually done (resume finalized) or needs the
user to answer something before it can finish. The caller persists
message_history and, on a reply, calls run_turn() again with that history so
the model continues the same reasoning thread rather than starting over.
"""
from __future__ import annotations

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


class ResuTurnOutput(BaseModel):
    """What the agent produces each turn. `done=False` means `question` holds
    something the user must answer before the resume can be finalized (e.g.
    the Step 7 clarifying questions, or a disqualifier-keyword stop). `done=True`
    means `resume` holds the finished, ready-to-save resume text.
    """

    done: bool
    resume: str | None = None
    question: str | None = None


_BASE_SYSTEM_PROMPT = (
    f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
    "Respond with structured output every turn: set done=true and put the "
    "complete finished resume in `resume` once you've gone through the full "
    "process template with no open questions. If you still need something "
    "from the user (answers to Step 7 questions, or you hit a disqualifier "
    "stop and want to confirm before continuing), set done=false and put "
    "exactly one clear question in `question` — the user will reply and you "
    "will continue from there in the next turn."
)

resu_agent = Agent(
    model=_model,
    deps_type=ResuDeps,
    output_type=ResuTurnOutput,
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
