"""Story Extraction Agent instance + entry point.

Two-phase pipeline, run within one run_turn() call:

  Phase 1 (attribution, stories_agent): given the full source text + the
  candidate's structured entries, split the text into one span per entry it
  covers, flag any gap/contradiction as a clarifying question, and keep the
  multi-turn chat going (done=False + question) until nothing is unresolved.
  Cheap output (spans + flags), regardless of how long the source text is.

  Phase 2 (write-up, write_up_agent): once attribution is fully resolved
  (done=True), run ONE SEPARATE call PER ENTRY, each given only that entry's
  own span, each with its own full max_tokens budget. This is what actually
  prevents compression on a long multi-entry document — phase 1 alone would
  have to share one output budget across every entry's narrative, which
  starves all of them regardless of how the prompt is worded; splitting the
  writing into one call per entry means each one gets the model's full
  output budget to itself.

Same multi-turn pattern as agent/resu/agent.py and agent/linkedin/agent.py at
the attribution layer: each run_turn() call is one full agent run (PydanticAI
has no mid-execution pause), but the structured output's `done` flag tells
the caller whether the chat is actually finished or needs the user to answer
something first. One session per source document/repo (see
agent/resu/stories/service.py + NestJS's SessionsService), labeled by that
source's filename/repo name in the UI.
"""
from __future__ import annotations

import asyncio
import os
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.settings import ModelSettings

from .deps import StoriesDeps
from .definition import (
    IDENTITY,
    INSTRUCTIONS,
    SOUL,
    WRITE_UP_INSTRUCTIONS,
    WRITE_UP_SOUL,
)

_model = OpenAIChatModel(
    os.environ.get("AZURE_LLM_DEPLOYMENT_NAME", "gpt-4.1"),
    provider=AzureProvider(
        azure_endpoint=os.environ["AZURE_LLM_ENDPOINT"],
        api_key=os.environ["AZURE_LLM_API_KEY"],
        api_version=os.environ.get("AZURE_LLM_API_VERSION", "2024-12-01-preview"),
    ),
)

# Both phases get a large, explicit max_tokens — the provider/SDK default
# (often a conservative ~4096) is exactly what silently truncates/compresses
# a long, detailed narrative no matter how the prompt is worded; an
# architectural ceiling needs an architectural fix, not better wording.
# Phase 2 additionally never shares this budget across more than one entry
# (see module docstring), so this is "per entry", not "per document".
_ATTRIBUTION_SETTINGS = ModelSettings(max_tokens=16000)
_WRITE_UP_SETTINGS = ModelSettings(max_tokens=16000)

EntryType = Literal["workExperience", "education", "internship", "project", "paper"]


class StorySpanOut(BaseModel):
    """One entry's attributed span from phase 1 — not yet the written-up
    story (see StoryCandidateOut), just "this text belongs to this entry."
    """

    entry_type: EntryType | None = None
    entry_id: str | None = None
    new_entry_label: str | None = None
    source_span: str
    confidence: float


class AttributionTurnOutput(BaseModel):
    """What phase 1 produces each turn. `done=False` means `question` holds
    a clarifying question about a gap or inconsistency the source text left
    unresolved — the user answers and the agent continues from there on the
    next turn. `done=True` means `spans` holds every entry's finished,
    fully-resolved span, ready for phase 2 to write up.
    """

    done: bool
    spans: list[StorySpanOut] | None = None
    question: str | None = None


class StoryCandidateOut(BaseModel):
    """One entry's finished, comprehensive story — phase 2's output, merged
    with its originating span's attribution for the final turn result.
    """

    entry_type: EntryType | None = None
    entry_id: str | None = None
    new_entry_label: str | None = None
    source_span: str
    story_text: str
    confidence: float


class StoriesTurnOutput(BaseModel):
    """What run_turn() returns overall. `done=False` means `question` holds
    a clarifying question (phase 1 still has an open gap) — the user answers
    and the caller continues from there on the next turn. `done=True` means
    `candidates` holds the finished, comprehensive per-entry stories, each
    written up in its own phase-2 call.
    """

    done: bool
    candidates: list[StoryCandidateOut] | None = None
    question: str | None = None


_ATTRIBUTION_SYSTEM_PROMPT = (
    f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
    "Respond with structured output every turn: set done=true and fill in "
    "`spans` once every entry the source text covers has a complete, "
    "gap-free span with no open questions. If the source text leaves a "
    "real gap or inconsistency you can't resolve on your own, set "
    "done=false, leave `spans` unset, and ask exactly ONE clear, specific "
    "question in `question` (reference the entry/company by name so the "
    "user knows what you're asking about). The user will reply and you "
    "will continue from there on the next turn. Don't ask about something "
    "the text already answers, and don't ask more than one question per "
    "turn — work through gaps one at a time."
)

stories_agent = Agent(
    model=_model,
    deps_type=StoriesDeps,
    output_type=AttributionTurnOutput,
    system_prompt=_ATTRIBUTION_SYSTEM_PROMPT,
    model_settings=_ATTRIBUTION_SETTINGS,
)


class WriteUpOutput(BaseModel):
    story_text: str


_WRITE_UP_SYSTEM_PROMPT = f"{WRITE_UP_SOUL}\n\n{WRITE_UP_INSTRUCTIONS}"

write_up_agent = Agent(
    model=_model,
    output_type=WriteUpOutput,
    system_prompt=_WRITE_UP_SYSTEM_PROMPT,
    model_settings=_WRITE_UP_SETTINGS,
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
            "to just that one entry. Every span you return must use this "
            "exact entry_type and entry_id; do not propose a new entry or "
            "match against anything else, even if the text seems to "
            "describe something slightly different — ask a clarifying "
            "question instead if it genuinely doesn't fit.\n\n"
        )
    return (
        f"Background hint: the user tagged this entire document as "
        f"\"{hint_entry_type}\" at upload time, and the entries list above "
        "has already been narrowed to only that category — every span you "
        "return must use this entry_type (or propose a new entry of this "
        "type); do not second-guess this boundary.\n\n"
    )


async def _write_up_span(span: StorySpanOut) -> StoryCandidateOut:
    """Phase 2: writes one entry's comprehensive story from its own span,
    in its own call with its own full output budget — see module docstring
    for why this has to be a separate call per entry, not one call for all
    of them together.
    """
    label = span.new_entry_label or span.entry_id or "this entry"
    prompt = (
        f"Entry: {label} ({span.entry_type or 'new entry'})\n\n"
        f"## Source text for this entry only\n{span.source_span}"
    )
    result = await write_up_agent.run(prompt)
    return StoryCandidateOut(
        entry_type=span.entry_type,
        entry_id=span.entry_id,
        new_entry_label=span.new_entry_label,
        source_span=span.source_span,
        story_text=result.output.story_text,
        confidence=span.confidence,
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

    Phase 1 (attribution) runs every turn to resolve gaps via chat. Only once
    phase 1 reports done=True does phase 2 (write-up) run, once per resolved
    span, each in its own call — see module docstring.
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
    attribution = result.output

    if not attribution.done:
        return (
            StoriesTurnOutput(done=False, candidates=None, question=attribution.question),
            result.all_messages(),
        )

    spans = attribution.spans or []
    candidates = await asyncio.gather(*(_write_up_span(span) for span in spans))
    return (
        StoriesTurnOutput(done=True, candidates=list(candidates), question=None),
        result.all_messages(),
    )
