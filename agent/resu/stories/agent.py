"""Document Generation — one function, generate_document(), called by
NestJS's StoriesService only when the user explicitly clicks "Generate" on
an entry (see agent/resu/stories/service.py). The result (HTML) is persisted
by the caller into EntryDocument, not cached/triggered implicitly — this
only ever runs on an explicit user action.

No attribution phase: every source is pinned to exactly one entry by the
user at upload/connect time, so there's nothing left to figure out about
which entry a piece of text belongs to — see definition.py's module
docstring.

Revise, not just extract: if an entry already has a document (freshly
generated or hand-edited by the user since), this call feeds the model both
the current document and the raw sources, instructed to preserve existing
content/phrasing except where new source material supersedes it — never a
blind from-scratch overwrite.

Write-up IS chunked for long sources: raw source text is split into ~12k-char
chunks. With no existing document, each chunk can be written up independently
and in parallel (own full output budget each), then concatenated in order —
same reasoning as before: one call asked to write up dozens of pages at once
shares one output budget across everything it produces, no matter how the
prompt is worded. With an existing document, chunks are instead applied as a
SEQUENTIAL FOLD (chunk N's call revises the document chunk N-1 produced) —
independent parallel chunk calls can't compose cleanly against one shared
existing document (each would try to revise the same base, producing
conflicting edits), so merge correctness is prioritized over chunk
parallelism in that case.
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

from pydantic import BaseModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.settings import ModelSettings
from pydantic_ai import Agent

from .definition import DOCUMENT_INSTRUCTIONS, DOCUMENT_SOUL
from ..rate_limit import LLM_CONCURRENCY, retry_on_rate_limit

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
# truncates/compresses a long, detailed document no matter how the prompt
# is worded, so every call gets an explicit budget near that ceiling.
# Chunking (below) is what keeps any single call's input/output proportional
# regardless of overall source length — the two fixes are complementary,
# neither alone is sufficient (see module docstring).
_DOCUMENT_SETTINGS = ModelSettings(max_tokens=32000)

# Roughly 3-4 pages of plain text per chunk — small enough that one chunk's
# write-up comfortably fits _DOCUMENT_SETTINGS' budget even when every
# sentence in the chunk is substantive, large enough that a single
# paragraph or bullet point essentially never gets split mid-thought. Also
# used as the "do we need to chunk at all" threshold for the whole combined
# source text (see generate_document).
_CHUNK_SIZE_CHARS = 12000
# Chunks overlap slightly so a sentence that happens to fall right on a
# chunk boundary still appears whole in at least one chunk, instead of
# being invisibly cut in half in both and omitted from both write-ups.
_CHUNK_OVERLAP_CHARS = 500


class DocumentOutput(BaseModel):
    content_html: str


_DOCUMENT_SYSTEM_PROMPT = f"{DOCUMENT_SOUL}\n\n{DOCUMENT_INSTRUCTIONS}"

document_agent = Agent(
    model=_model,
    output_type=DocumentOutput,
    system_prompt=_DOCUMENT_SYSTEM_PROMPT,
    model_settings=_DOCUMENT_SETTINGS,
)


def _chunk_text(text: str) -> list[str]:
    """Splits raw text into overlapping chunks of roughly _CHUNK_SIZE_CHARS
    characters — see module docstring for why chunking (not just a higher
    max_tokens) is what actually lets a long document get fully, faithfully
    written up: no single call holds more than one chunk's worth of source
    text, so its own output budget is never asked to cover more than that
    chunk's content.
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


async def _generate_or_revise_chunk(
    existing_html: str, source_chunk: str, chunk_index: int, chunk_count: int, entry_label: str,
) -> str:
    prompt = (
        f"Entry: {entry_label}\n"
        f"Chunk {chunk_index + 1} of {chunk_count}\n\n"
        f"## Current document (may be empty, may contain user edits — preserve "
        f"everything in it not contradicted/extended by the source below)\n"
        f"{existing_html or '[empty]'}\n\n"
        f"## New/changed source text for this entry (this chunk only)\n{source_chunk}"
    )
    # Bounded by the process-wide LLM_CONCURRENCY semaphore, and retried
    # with backoff on 429 — a single resume generation session's worth of
    # Generate clicks can still add up to several concurrent calls, which
    # otherwise reliably bursts past the Azure deployment's per-minute
    # token rate limit (see rate_limit.py).
    async with LLM_CONCURRENCY:
        result = await retry_on_rate_limit(lambda: document_agent.run(prompt))
    return result.output.content_html


async def generate_document(existing_document_html: str, raw_sources: list[str], entry_label: str) -> str:
    """Generates (if existing_document_html is empty) or revises (if
    non-empty) one entry's detailed document from its raw tagged sources.
    entry_label is a human-readable name (e.g. "Dell — Software Engineer")
    for the prompt; the entry's identity has already been pinned by
    whoever called this. Returns the full document HTML.
    """
    combined_source = "\n\n---\n\n".join(s for s in raw_sources if s.strip())
    if not combined_source.strip():
        # Nothing new to fold in — leave the existing document (if any) as-is
        # rather than asking the model to revise against empty source text.
        return existing_document_html

    if len(combined_source) <= _CHUNK_SIZE_CHARS:
        return await _generate_or_revise_chunk(existing_document_html, combined_source, 0, 1, entry_label)

    chunks = _chunk_text(combined_source)

    if not existing_document_html.strip():
        # No existing document to merge against — chunks are independent,
        # so write them up in parallel and concatenate, same as the old
        # narrative-extraction flow.
        htmls = await asyncio.gather(
            *(
                _generate_or_revise_chunk("", chunk, i, len(chunks), entry_label)
                for i, chunk in enumerate(chunks)
            )
        )
        return "\n".join(h for h in htmls if h.strip())

    # Existing document to merge against — sequential fold, not parallel:
    # each chunk's call revises the document the PREVIOUS chunk's call
    # produced, so the final result is one coherent edit stream applied in
    # order rather than N independent simultaneous edits to the same base.
    current_html = existing_document_html
    for i, chunk in enumerate(chunks):
        current_html = await _generate_or_revise_chunk(current_html, chunk, i, len(chunks), entry_label)
    return current_html
