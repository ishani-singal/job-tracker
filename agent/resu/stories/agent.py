"""Document Generation — called by NestJS's SessionsService as a chat-style
session (see agent/resu/stories/service.py's /stories/run-turn), one session
per "Generate" click on an entry (see entry-document-editor.tsx). The result
(HTML) is persisted by the caller into EntryDocument only once the user
explicitly Accepts the session — not implicitly, and not until the whole
turn sequence finishes.

Two-phase turn, mirroring agent/resu/agent.py's run_turn shape (done/
question) but intentionally NOT reusing its chunked generation machinery for
the question check — asking "is anything unclear" is one cheap call,
independent of how many chunks the eventual write-up needs:
  1. First turn (user_reply is None): run _check_for_clarification — one
     small call deciding whether the source material has a genuine,
     resolvable gap/contradiction worth asking about. If yes, return
     done=False, question=... and STOP — generate_document has not run yet,
     nothing expensive has happened. If no, fall through to generation.
  2. Second turn (user_reply is not None, i.e. the user answered): fold the
     answer in as extra context and run generation, return done=True.
  3. First turn with no question needed: run generation immediately,
     done=True, same turn.

No attribution phase: every source is pinned to exactly one entry by the
user at upload/connect time, so there's nothing left to figure out about
which entry a piece of text belongs to — see definition.py's module
docstring.

Revise, not just extract: if an entry already has a document (freshly
generated or hand-edited by the user since), generation feeds the model both
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

from .definition import CLARIFY_INSTRUCTIONS, CLARIFY_SOUL, DOCUMENT_INSTRUCTIONS, DOCUMENT_SOUL
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


class ClarifyOutput(BaseModel):
    has_question: bool
    question: str = ""


_DOCUMENT_SYSTEM_PROMPT = f"{DOCUMENT_SOUL}\n\n{DOCUMENT_INSTRUCTIONS}"

document_agent = Agent(
    model=_model,
    output_type=DocumentOutput,
    system_prompt=_DOCUMENT_SYSTEM_PROMPT,
    model_settings=_DOCUMENT_SETTINGS,
)

_CLARIFY_SYSTEM_PROMPT = f"{CLARIFY_SOUL}\n\n{CLARIFY_INSTRUCTIONS}"

# A separate, much smaller agent from document_agent — this call's only job
# is a yes/no-plus-one-question decision, not writing the document itself,
# so it doesn't need document_agent's 32k max_tokens budget.
clarify_agent = Agent(
    model=_model,
    output_type=ClarifyOutput,
    system_prompt=_CLARIFY_SYSTEM_PROMPT,
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


async def generate_document(
    existing_document_html: str,
    raw_sources: list[str],
    entry_label: str,
    clarification: str | None = None,
) -> str:
    """Generates (if existing_document_html is empty) or revises (if
    non-empty) one entry's detailed document from its raw tagged sources.
    entry_label is a human-readable name (e.g. "Dell — Software Engineer")
    for the prompt; the entry's identity has already been pinned by
    whoever called this. `clarification` is the user's answer to a question
    _check_for_clarification asked earlier this session, if any — folded in
    as an extra source so the model can use it to resolve the gap it asked
    about. Returns the full document HTML.
    """
    sources = list(raw_sources)
    if clarification and clarification.strip():
        sources = [
            f"User-provided clarification (answers a question asked about "
            f"this entry's source material): {clarification}",
            *sources,
        ]

    combined_source = "\n\n---\n\n".join(s for s in sources if s.strip())
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


async def _check_for_clarification(
    existing_document_html: str, raw_sources: list[str], entry_label: str,
) -> str | None:
    """One small, cheap call deciding whether the source material has a
    genuine, resolvable gap/contradiction worth asking the user about before
    writing starts. Returns the question text, or None if generation should
    just proceed. Deliberately separate from document_agent/generate_document
    — this never needs chunking (it's a yes/no-plus-one-question judgment
    over a summary of the material, not a full write-up) and must stay cheap
    even for large source sets.
    """
    combined_source = "\n\n---\n\n".join(s for s in raw_sources if s.strip())
    if not combined_source.strip():
        return None

    prompt = (
        f"Entry: {entry_label}\n\n"
        f"## Current document (may be empty)\n{existing_document_html or '[empty]'}\n\n"
        f"## Raw source material tagged to this entry\n{combined_source[:_CHUNK_SIZE_CHARS]}"
    )
    try:
        # This check is optional — skipping it just means generation
        # proceeds without asking anything, which is always a safe
        # fallback. It deliberately does NOT go through
        # retry_on_rate_limit's up-to-90s backoff: that budget is worth
        # spending on the write-up itself (generate_document, below), not
        # doubled here on a nice-to-have pre-check. A single quick attempt
        # (no retry) keeps this call's worst case small, so a rate-limited
        # Azure deployment degrades to "no question asked" rather than
        # compounding both calls' retry budgets into one very slow or
        # outright-timed-out turn (this is what caused 300s+ turns that
        # tripped the Node fetch timeout after this feature moved to a
        # two-call session flow).
        async with LLM_CONCURRENCY:
            result = await clarify_agent.run(prompt)
    except Exception:
        return None
    output = result.output
    return output.question if output.has_question and output.question.strip() else None


async def run_entry_document_turn(
    existing_document_html: str,
    raw_sources: list[str],
    entry_label: str,
    user_reply: str | None,
    already_asked: bool,
) -> tuple[bool, str | None, str | None]:
    """One turn of the entry-document generation session (see module
    docstring for the two-phase shape). Returns (done, content_html,
    question) — exactly one of content_html/question is set when done is
    True/False respectively.

    `already_asked` is True once this session has already asked a
    clarifying question (i.e. this is the turn answering it) — skips the
    clarify check on that turn so a single session only ever asks once,
    then always proceeds to generation using the user's reply as
    clarification context.
    """
    if not already_asked:
        question = await _check_for_clarification(existing_document_html, raw_sources, entry_label)
        if question:
            return False, None, question

    content_html = await generate_document(existing_document_html, raw_sources, entry_label, user_reply)
    return True, content_html, None
