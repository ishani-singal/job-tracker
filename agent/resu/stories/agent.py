"""Story Extraction Agent instance + entry point.

Multi-turn, same pattern as agent/resu/agent.py and agent/linkedin/agent.py:
each run_turn() call is one full agent run (PydanticAI has no mid-execution
pause), but the structured output's `done` flag tells the caller whether the
story is actually finished or the agent needs the user to fill a gap/resolve
an inconsistency first. One session per source document/repo (see
agent/resu/stories/service.py + NestJS's SessionsService), labeled by that
source's filename/repo name in the UI.
"""
from __future__ import annotations

import os
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider

from .deps import StoriesDeps
from .definition import IDENTITY, INSTRUCTIONS, SOUL

_model = OpenAIChatModel(
    os.environ.get("AZURE_LLM_DEPLOYMENT_NAME", "gpt-4.1"),
    provider=AzureProvider(
        azure_endpoint=os.environ["AZURE_LLM_ENDPOINT"],
        api_key=os.environ["AZURE_LLM_API_KEY"],
        api_version=os.environ.get("AZURE_LLM_API_VERSION", "2024-12-01-preview"),
    ),
)

EntryType = Literal["workExperience", "education", "internship", "project", "paper"]


class StoryCandidateOut(BaseModel):
    entry_type: EntryType | None = None
    entry_id: str | None = None
    new_entry_label: str | None = None
    source_span: str
    story_text: str
    confidence: float


class StoriesTurnOutput(BaseModel):
    """What the agent produces each turn. `done=False` means `question` holds
    a clarifying question about a gap or inconsistency the source text left
    unresolved — the user answers and the agent continues from there on the
    next turn. `done=True` means `candidates` holds the finished, comprehensive
    per-entry stories derived from this source (plus the user's answers).
    """

    done: bool
    candidates: list[StoryCandidateOut] | None = None
    question: str | None = None


_SYSTEM_PROMPT = (
    f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
    "Respond with structured output every turn: set done=true and fill in "
    "`candidates` once every entry the source text covers has a complete, "
    "comprehensive, gap-free story with no open questions. If the source "
    "text leaves a real gap or inconsistency you can't resolve on your own "
    "— a missing date range, an unclear scope ('managed a team' with no "
    "size), a contradiction (two different titles for the same period), or "
    "a vague claim that needs a concrete detail to be useful in a resume — "
    "set done=false, leave `candidates` unset, and ask exactly ONE clear, "
    "specific question in `question` (reference the entry/company by name "
    "so the user knows what you're asking about). The user will reply and "
    "you will continue from there on the next turn. Don't ask about "
    "something the text already answers, and don't ask more than one "
    "question per turn — work through gaps one at a time."
)

stories_agent = Agent(
    model=_model,
    deps_type=StoriesDeps,
    output_type=StoriesTurnOutput,
    system_prompt=_SYSTEM_PROMPT,
)


def _render_entries_for_matching(entries: dict) -> str:
    """Renders the candidate's structured entries as a flat, id-labeled list
    for the extraction model to match source text against — deliberately
    simpler than resu/definition.py's _render_entries (no required/optional
    split, since that's a generation-time concept, not an attribution one).
    """
    lines: list[str] = []

    def add_group(label: str, entry_type: str, items: list[dict], name_fn) -> None:
        for e in items:
            dates = []
            if e.get("startYear"):
                dates.append(str(e["startYear"]))
            if e.get("isPresent"):
                dates.append("Present")
            elif e.get("endYear"):
                dates.append(str(e["endYear"]))
            date_range = "–".join(dates) if dates else "?"
            lines.append(f"- [{entry_type}] id={e['id']}: {name_fn(e)} [{date_range}]")

    add_group(
        "Work Experience",
        "workExperience",
        entries.get("workExperience", []),
        lambda e: f"{e['company']}" + (f" — {e['title']}" if e.get("title") else ""),
    )
    add_group(
        "Education",
        "education",
        entries.get("education", []),
        lambda e: f"{e['school']}" + (f" — {e['degree']}" if e.get("degree") else ""),
    )
    add_group(
        "Internships",
        "internship",
        entries.get("internships", []),
        lambda e: f"{e['company']}" + (f" — {e['title']}" if e.get("title") else ""),
    )
    add_group(
        "Projects",
        "project",
        entries.get("projects", []),
        lambda e: e["name"],
    )
    add_group(
        "Papers",
        "paper",
        entries.get("papers", []),
        lambda e: e["title"],
    )

    return "\n".join(lines) if lines else "(no structured entries yet)"


def _render_hint_line(hint_entry_type: str | None, hint_entry_id: str | None) -> str:
    if not hint_entry_type:
        return ""
    if hint_entry_id:
        return (
            f"Background hint: the user pinned this entire document to one "
            f"specific \"{hint_entry_type}\" entry (id={hint_entry_id}) at "
            "upload time — the entries list above has already been narrowed "
            "to just that one entry. Every candidate you return must use "
            "this exact entry_type and entry_id; do not propose a new entry "
            "or match against anything else, even if the text seems to "
            "describe something slightly different — ask a clarifying "
            "question instead if it genuinely doesn't fit.\n\n"
        )
    return (
        f"Background hint: the user tagged this entire document as "
        f"\"{hint_entry_type}\" at upload time, and the entries list above "
        "has already been narrowed to only that category — every candidate "
        "you return must use this entry_type (or propose a new entry of "
        "this type); do not second-guess this boundary.\n\n"
    )


async def run_turn(
    raw_text: str,
    source_type: str,
    source_label: str,
    entries: dict,
    api_base_url: str,
    hint_entry_type: str | None,
    hint_entry_id: str | None,
    message_history: list[ModelMessage] | None,
    user_reply: str | None,
) -> tuple[StoriesTurnOutput, list[ModelMessage]]:
    """Runs one turn of the per-document story-extraction conversation.

    First turn: message_history=None, user_reply=None — starts fresh with
    the full source text. Later turns: message_history from the prior turn's
    all_messages(), user_reply is the user's answer to the agent's question.
    Returns (output, updated_message_history) — the caller persists both.
    """
    deps = StoriesDeps(api_base_url=api_base_url)

    if message_history:
        prompt = user_reply or ""
    else:
        entries_block = _render_entries_for_matching(entries)
        hint_line = _render_hint_line(hint_entry_type, hint_entry_id)
        prompt = (
            f"Source type: {source_type}\n"
            f"Source label: {source_label}\n\n"
            f"{hint_line}"
            f"## Candidate's structured entries (match source text against these)\n{entries_block}\n\n"
            f"## Source text to attribute\n{raw_text}"
        )

    result = await stories_agent.run(prompt, deps=deps, message_history=message_history)
    return result.output, result.all_messages()
