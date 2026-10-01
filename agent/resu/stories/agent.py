"""Narrative Extraction — one function, extract_narrative(), called live by
NestJS's StoriesService the first time a resume generation needs a given
entry's narrative from a given source (see agent/resu/stories/service.py).
Result is cached by the caller (ExtractedNarrative) keyed to that source, so
this only actually runs again when the source file/repo changes.

No attribution phase: every source is pinned to exactly one entry by the
user at upload/connect time, so there's nothing left to figure out about
which entry a piece of text belongs to — see definition.py's module
docstring for why that used to be a separate phase and no longer is.

No gap-review chat either: live generation has no user turn to answer a
clarifying question, so a gap/contradiction is just written as faithfully
as the source supports (see definition.py's WRITE_UP_INSTRUCTIONS) rather
than paused on.

Write-up IS chunked: the raw text is split into ~12k-char chunks, each
written up independently and in parallel (own full output budget each), and
the per-chunk narratives are concatenated in order into the final result.
This is what actually prevents compression on a long single-entry document
— one call asked to narrate dozens of pages at once shares one output
budget across everything it produces, no matter how the prompt is worded;
splitting into one call per chunk means each chunk's narrative gets the
model's entire output budget to itself.
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.settings import ModelSettings

from .definition import WRITE_UP_INSTRUCTIONS, WRITE_UP_SOUL

_model = OpenAIChatModel(
    os.environ.get("AZURE_LLM_DEPLOYMENT_NAME", "gpt-4.1"),
    provider=AzureProvider(
        azure_endpoint=os.environ["AZURE_LLM_ENDPOINT"],
        api_key=os.environ["AZURE_LLM_API_KEY"],
        api_version=os.environ.get("AZURE_LLM_API_VERSION", "2024-12-01-preview"),
    ),
)

# gpt-4.1 on Azure supports up to 32768 output tokens per call — the
# SDK/provider default (often a conservative ~4096) is exactly what silently
# truncates/compresses a long, detailed narrative no matter how the prompt
# is worded, so every write-up call gets an explicit budget near that
# ceiling. Chunking (below) is what keeps any single call's input/output
# proportional regardless of overall document length — the two fixes are
# complementary, neither alone is sufficient (see module docstring).
_WRITE_UP_SETTINGS = ModelSettings(max_tokens=32000)

# Roughly 3-4 pages of plain text per chunk — small enough that one chunk's
# write-up comfortably fits _WRITE_UP_SETTINGS' budget even when every
# sentence in the chunk is substantive, large enough that a single
# paragraph or bullet point essentially never gets split mid-thought.
_CHUNK_SIZE_CHARS = 12000
# Chunks overlap slightly so a sentence that happens to fall right on a
# chunk boundary still appears whole in at least one chunk, instead of
# being invisibly cut in half in both and omitted from both write-ups.
_CHUNK_OVERLAP_CHARS = 500


class WriteUpOutput(BaseModel):
    narrative_text: str


_WRITE_UP_SYSTEM_PROMPT = f"{WRITE_UP_SOUL}\n\n{WRITE_UP_INSTRUCTIONS}"

write_up_agent = Agent(
    model=_model,
    output_type=WriteUpOutput,
    system_prompt=_WRITE_UP_SYSTEM_PROMPT,
    model_settings=_WRITE_UP_SETTINGS,
)


def _chunk_text(text: str) -> list[str]:
    """Splits raw text into overlapping chunks of roughly _CHUNK_SIZE_CHARS
    characters — see module docstring for why chunking (not just a higher
    max_tokens) is what actually lets a long document get fully, faithfully
    narrated: no single write-up call holds more than one chunk's worth of
    source text, so its own output budget is never asked to cover more than
    that chunk's content.
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


async def _write_up_chunk(chunk: str, chunk_index: int, chunk_count: int, entry_label: str) -> str:
    prompt = (
        f"Entry: {entry_label}\n"
        f"Chunk {chunk_index + 1} of {chunk_count}\n\n"
        f"## Source text for this entry (this chunk only)\n{chunk}"
    )
    result = await write_up_agent.run(prompt)
    return result.output.narrative_text


async def extract_narrative(raw_text: str, entry_label: str) -> str:
    """Writes up a comprehensive narrative from raw_text, chunked as needed
    for length — see module docstring. entry_label is just a human-readable
    name (e.g. "Dell — Software Engineer") for the prompt; the entry's
    identity has already been pinned by whoever called this (the source was
    tagged to it at upload/connect time), there's nothing to resolve here.
    Returns the full narrative, chunk write-ups concatenated in order.
    """
    if not raw_text.strip():
        return ""

    chunks = _chunk_text(raw_text)
    narratives = await asyncio.gather(
        *(
            _write_up_chunk(chunk, i, len(chunks), entry_label)
            for i, chunk in enumerate(chunks)
        )
    )
    return "\n\n".join(n for n in narratives if n.strip())
