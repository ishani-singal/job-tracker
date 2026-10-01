"""LinkedIn Description Agent's Agent instance + entry point.

Multi-turn, same pattern as agent/resu/agent.py: each run_turn() call is one
full agent run (PydanticAI has no mid-execution pause), but the structured
output's `done` flag tells the caller whether it's actually finished or needs
the user to answer something first. No application_id anywhere — this agent
is whole-candidate scoped, not tied to a single job application.
"""
from __future__ import annotations

import os
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider

from .deps import LinkedinDeps
from .definition import IDENTITY, INSTRUCTIONS, SOUL, TOOLS

# The OpenAI/Azure SDK's own default httpx timeout is generous enough that a
# hung or silently-stalled connection to Azure can block a call indefinitely
# with nothing ever raising — a resu-side generation got stuck 10+ minutes
# this way with zero progress and no error. Duplicated here rather than
# imported from agent/resu per this file's own copy-paste-not-import
# convention (see module docstring).
_AZURE_HTTP_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

_model = OpenAIChatModel(
    os.environ.get("AZURE_LLM_DEPLOYMENT_NAME", "gpt-4.1"),
    provider=AzureProvider(
        azure_endpoint=os.environ["AZURE_LLM_ENDPOINT"],
        api_key=os.environ["AZURE_LLM_API_KEY"],
        api_version=os.environ.get("AZURE_LLM_API_VERSION", "2024-12-01-preview"),
        http_client=httpx.AsyncClient(timeout=_AZURE_HTTP_TIMEOUT),
    ),
)


EntryType = Literal["workExperience", "education", "internship", "project"]


class LinkedinEntryBullets(BaseModel):
    # Matches fetch_structured_entries' own key names exactly (workExperience,
    # education, internships->internship singular, projects->project
    # singular) — constrained to a real enum so the model can't drift between
    # casings/vocabularies across runs the way a free-form str did.
    entry_type: EntryType
    entry_id: str
    bullets: list[str]


class LinkedinTurnOutput(BaseModel):
    """What the agent produces each turn. `done=False` means `question` holds
    something the user must answer before the draft can be finalized. `done=True`
    means headline/about/entry_bullets hold the finished, ready-to-save draft.
    """

    done: bool
    headline: str | None = None
    about: str | None = None
    entry_bullets: list[LinkedinEntryBullets] | None = None
    question: str | None = None


_SYSTEM_PROMPT = (
    f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
    "Respond with structured output every turn: set done=true and fill in "
    "headline, about, and entry_bullets once you have everything you need with "
    "no open questions. If you need something from the user first, set "
    "done=false and put exactly one clear question in `question` — the user "
    "will reply and you will continue from there in the next turn."
)

linkedin_agent = Agent(
    model=_model,
    deps_type=LinkedinDeps,
    output_type=LinkedinTurnOutput,
    system_prompt=_SYSTEM_PROMPT,
    tools=TOOLS,
)


async def run_turn(
    api_base_url: str,
    message_history: list[ModelMessage] | None,
    user_reply: str | None,
) -> tuple[LinkedinTurnOutput, list[ModelMessage]]:
    """Runs one turn of the LinkedIn-drafting conversation.

    First turn: message_history=None, user_reply=None — starts fresh.
    Later turns: message_history from the prior turn's all_messages(),
    user_reply is what the user typed in response to the agent's question.
    Returns (output, updated_message_history) — the caller persists both.
    """
    deps = LinkedinDeps(api_base_url=api_base_url)
    prompt = (
        user_reply
        if message_history
        else "Generate updated LinkedIn profile copy (headline, About, and "
        "per-entry bullets) based on the candidate's current background."
    )
    result = await linkedin_agent.run(
        prompt,
        deps=deps,
        message_history=message_history,
    )
    return result.output, result.all_messages()
