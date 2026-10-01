"""Story Extraction Agent instance + entry point.

Three-phase pipeline, run within one run_turn() call:

  Phase 1 (chunked attribution, stories_agent): the raw source text is split
  into page-range chunks (see _chunk_text) and each chunk is attributed
  INDEPENDENTLY — "which entries does this chunk cover, and what's each
  one's verbatim span within this chunk." This is what actually fixes "a
  long document doesn't get fully covered": no single call ever has to hold
  more than one chunk's worth of text in its own output budget, however many
  pages the whole document runs. Spans for the same entry across different
  chunks are concatenated together afterward (_merge_spans_by_entry) into
  that entry's full span across the whole document.

  Phase 2 (gap review, gap_review_agent): a single lightweight pass over the
  merged spans (not the raw document — already small) that flags any real
  gap/contradiction as a clarifying question. This is the one point with
  genuine multi-turn chat state (done=False + question, resumed via
  PydanticAI message_history) — chunked attribution itself is stateless and
  re-run fresh from raw_text on every call, so it never needs to survive
  across turns.

  Phase 3 (write-up, write_up_agent): once gap review reports done=True, one
  SEPARATE call PER ENTRY, each given only that entry's own full merged
  span, each with its own full max_tokens budget. Splitting the writing into
  one call per entry means each entry's narrative gets the model's entire
  output budget to itself, regardless of how many other entries the document
  also covers.

Same multi-turn pattern as agent/resu/agent.py and agent/linkedin/agent.py at
the gap-review layer: each run_turn() call is one full agent run (PydanticAI
has no mid-execution pause), but the structured output's `done` flag tells
the caller whether the chat is actually finished or needs the user to answer
something first. One session per source document/repo (see
agent/resu/stories/service.py + NestJS's SessionsService), labeled by that
source's filename/repo name in the UI.
"""
from __future__ import annotations

import asyncio
import json
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

# gpt-4.1 on Azure supports up to 32768 output tokens per call — every phase
# below gets a large, explicit max_tokens near that ceiling, since the
# SDK/provider default (often a conservative ~4096) is exactly what silently
# truncates/compresses a long, detailed narrative no matter how the prompt
# is worded. An architectural ceiling needs an architectural fix (raising
# the ceiling, AND never asking one call to fill it with more than one
# chunk/entry's worth of content — see module docstring), not better wording
# alone.
_ATTRIBUTION_SETTINGS = ModelSettings(max_tokens=32000)
_GAP_REVIEW_SETTINGS = ModelSettings(max_tokens=8000)
_WRITE_UP_SETTINGS = ModelSettings(max_tokens=32000)

# Roughly 3-4 pages of plain text per chunk — small enough that one chunk's
# attribution output (its spans) comfortably fits _ATTRIBUTION_SETTINGS'
# budget even in the worst case (the whole chunk being one entry's span),
# large enough that an entry's content occurring in one place in the
# document usually stays within a single chunk rather than being needlessly
# split across many.
_CHUNK_SIZE_CHARS = 12000
# Chunks overlap slightly so a sentence that happens to fall right on a
# chunk boundary still appears whole in at least one chunk's attribution
# pass, instead of being invisibly cut in half in both.
_CHUNK_OVERLAP_CHARS = 500

EntryType = Literal["workExperience", "education", "internship", "project", "paper"]


class StorySpanOut(BaseModel):
    """One entry's attributed span from phase 1 (within a single chunk) —
    not yet the written-up story (see StoryCandidateOut), just "this text
    belongs to this entry."
    """

    entry_type: EntryType | None = None
    entry_id: str | None = None
    new_entry_label: str | None = None
    source_span: str
    confidence: float


class ChunkAttributionOutput(BaseModel):
    """What one chunk's attribution pass produces — always a flat list, no
    done/question here: chunked attribution is stateless and has no chat of
    its own (see module docstring) — gaps are reviewed afterward, once,
    across all chunks' merged spans together, not per chunk.
    """

    spans: list[StorySpanOut]


class GapReviewTurnOutput(BaseModel):
    """What phase 2 produces each turn. `done=False` means `question` holds
    a clarifying question about a gap or inconsistency the merged spans
    left unresolved — the user answers and the agent continues from there on
    the next turn. `done=True` means `spans` holds every entry's finished,
    fully-resolved span (identical in shape to what phase 1 produced, just
    reviewed/corrected), ready for phase 3 to write up.
    """

    done: bool
    spans: list[StorySpanOut] | None = None
    question: str | None = None


class StoryCandidateOut(BaseModel):
    """One entry's finished, comprehensive story — phase 3's output, merged
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
    a clarifying question (phase 2 still has an open gap) — the user answers
    and the caller continues from there on the next turn. `done=True` means
    `candidates` holds the finished, comprehensive per-entry stories, each
    written up in its own phase-3 call.
    """

    done: bool
    candidates: list[StoryCandidateOut] | None = None
    question: str | None = None


_ATTRIBUTION_SYSTEM_PROMPT = (
    f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}\n\n"
    "You are being given ONE CHUNK of a larger document, not the whole "
    "thing — other chunks before and after this one cover the rest, and "
    "will be attributed separately and merged with this chunk's result "
    "later. Attribute only what THIS chunk actually contains; don't worry "
    "about entries this chunk doesn't mention, and don't ask questions here "
    "— any gap or inconsistency gets reviewed once, later, across the "
    "merged result from every chunk together, not per chunk. Respond with "
    "structured output: `spans`, one per distinct entry this chunk covers. "
    "An empty list is correct if this chunk has nothing attributable."
)

stories_agent = Agent(
    model=_model,
    output_type=ChunkAttributionOutput,
    system_prompt=_ATTRIBUTION_SYSTEM_PROMPT,
    model_settings=_ATTRIBUTION_SETTINGS,
)


_GAP_REVIEW_SYSTEM_PROMPT = (
    f"{SOUL}\n\n"
    "You are reviewing already-attributed spans — text already split out "
    "per entry from a larger document, potentially stitched together from "
    "several chunks of that document — for real gaps or inconsistencies "
    "before they get written up into full stories. Before finishing, check "
    "every span for real holes or inconsistencies: a claimed scope with no "
    "concrete number where one would obviously exist (team size, budget, "
    "user count, percentage), a date range that doesn't line up with the "
    "matched entry's own dates, a title or company name that conflicts "
    "with the entry, or a sentence that trails off into vague language "
    "('worked on various initiatives') where the text clearly implies "
    "there's a specific answer it just didn't spell out. When you find "
    "one, don't resolve it with a plausible-sounding guess — ask the user "
    "about it directly, naming the entry/company so they know which one "
    "you mean, and wait for their answer before finishing that entry. Two "
    "spans with the same entry_type+entry_id have already been "
    "concatenated together for you — if the combined result for one entry "
    "now looks internally contradictory (e.g. two different team sizes "
    "stated for the same period), that is exactly the kind of "
    "inconsistency to ask about, don't silently pick one.\n\n"
    "It's fine to finish other, already-complete spans in the same turn "
    "while still having an open question about a different one — but if a "
    "question is still open for ANY entry, set done=false for this turn "
    "rather than returning a partially-reviewed spans list; ask the single "
    "most important open question first, and continue asking one at a time "
    "on each following turn until nothing is left unresolved, then set "
    "done=true and return every entry's (possibly user-corrected) span "
    "together, unchanged from what you were given except for whatever the "
    "user's answers corrected."
)

gap_review_agent = Agent(
    model=_model,
    output_type=GapReviewTurnOutput,
    system_prompt=_GAP_REVIEW_SYSTEM_PROMPT,
    model_settings=_GAP_REVIEW_SETTINGS,
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


def _chunk_text(text: str) -> list[str]:
    """Splits raw_text into overlapping chunks of roughly _CHUNK_SIZE_CHARS
    characters — see module docstring for why chunking (not just a higher
    max_tokens) is what actually lets a 41-page document get fully covered:
    no single attribution call holds more than one chunk's worth of source
    text, so its own output budget is never asked to describe the whole
    document's worth of entries at once.
    """
    if len(text) <= _CHUNK_SIZE_CHARS:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + _CHUNK_SIZE_CHARS, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = end - _CHUNK_OVERLAP_CHARS
    return chunks


def _span_key(span: StorySpanOut) -> tuple[str | None, str | None, str | None]:
    return (span.entry_type, span.entry_id, span.new_entry_label)


def _merge_spans_by_entry(all_spans: list[StorySpanOut]) -> list[StorySpanOut]:
    """Concatenates every chunk's spans for the same entry into one span
    covering that entry's content across the whole document — see module
    docstring. Confidence is the minimum across merged spans (a document
    that was ambiguous about an entry in even one chunk should still get
    flagged for review, not have that diluted by other, more confident
    chunks).
    """
    merged: dict[tuple[str | None, str | None, str | None], StorySpanOut] = {}
    for span in all_spans:
        key = _span_key(span)
        existing = merged.get(key)
        if existing is None:
            merged[key] = span.model_copy()
        else:
            existing.source_span = f"{existing.source_span}\n\n{span.source_span}"
            existing.confidence = min(existing.confidence, span.confidence)
    return list(merged.values())


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
            "describe something slightly different.\n\n"
        )
    return (
        f"Background hint: the user tagged this entire document as "
        f"\"{hint_entry_type}\" at upload time, and the entries list above "
        "has already been narrowed to only that category — every span you "
        "return must use this entry_type (or propose a new entry of this "
        "type); do not second-guess this boundary.\n\n"
    )


async def _attribute_chunk(
    chunk: str,
    chunk_index: int,
    chunk_count: int,
    entries_block: str,
    hint_line: str,
    source_type: str,
    source_label: str,
) -> list[StorySpanOut]:
    prompt = (
        f"Source type: {source_type}\n"
        f"Source label: {source_label}\n"
        f"Chunk {chunk_index + 1} of {chunk_count}\n\n"
        f"{hint_line}"
        f"## Candidate's structured entries (match source text against these)\n{entries_block}\n\n"
        f"## Source text to attribute (this chunk only)\n{chunk}"
    )
    result = await stories_agent.run(prompt)
    return result.output.spans


async def _write_up_span(span: StorySpanOut) -> StoryCandidateOut:
    """Phase 3: writes one entry's comprehensive story from its own full
    (chunk-merged) span, in its own call with its own full output budget —
    see module docstring for why this has to be a separate call per entry,
    not one call for all of them together.
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


def _render_spans_for_review(spans: list[StorySpanOut]) -> str:
    return json.dumps([s.model_dump() for s in spans], indent=2)


async def run_turn(
    raw_text: str,
    source_type: str,
    source_label: str,
    entries: dict,
    api_base_url: str,  # unused — kept for call-site compatibility with service.py
    hint_entry_type: str | None,
    hint_entry_id: str | None,
    message_history: list[ModelMessage] | None,
    user_reply: str | None,
) -> tuple[StoriesTurnOutput, list[ModelMessage]]:
    """Runs one turn of the per-document story-extraction conversation.

    First turn (message_history=None): runs the full chunked-attribution
    pass (phase 1, stateless, re-derives merged spans fresh every time) and
    then starts the gap-review chat (phase 2) on the merged result. Later
    turns (message_history set): message_history belongs to the gap-review
    agent only — chunked attribution never needs to be resumed, it's cheap
    enough to not bother persisting across turns, and user_reply is the
    user's answer to gap-review's question. Once gap-review reports
    done=True, phase 3 (write-up) runs once per resolved span, each in its
    own call — see module docstring.
    """
    if message_history:
        gap_review_result = await gap_review_agent.run(
            user_reply or "", message_history=message_history
        )
    else:
        entries_block = _render_entries_for_matching(entries)
        hint_line = _render_hint_line(hint_entry_type, hint_entry_id)
        chunks = _chunk_text(raw_text)

        chunk_results = await asyncio.gather(
            *(
                _attribute_chunk(
                    chunk, i, len(chunks), entries_block, hint_line, source_type, source_label
                )
                for i, chunk in enumerate(chunks)
            )
        )
        all_spans = [span for spans in chunk_results for span in spans]
        merged_spans = _merge_spans_by_entry(all_spans)

        gap_review_prompt = (
            f"## Attributed spans to review (merged across {len(chunks)} document chunks)\n"
            f"{_render_spans_for_review(merged_spans)}"
        )
        gap_review_result = await gap_review_agent.run(gap_review_prompt)

    review = gap_review_result.output

    if not review.done:
        return (
            StoriesTurnOutput(done=False, candidates=None, question=review.question),
            gap_review_result.all_messages(),
        )

    spans = review.spans or []
    candidates = await asyncio.gather(*(_write_up_span(span) for span in spans))
    return (
        StoriesTurnOutput(done=True, candidates=list(candidates), question=None),
        gap_review_result.all_messages(),
    )
