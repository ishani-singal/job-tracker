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

Processed per SOURCE (one Story/Resume file or GitHub repo = one source),
not per arbitrary character-chunk of a combined blob. Sources are
evaluated ONE AT A TIME by default (_SOURCE_CONCURRENCY=1) — a Generate
click against an entry with many tagged sources runs them strictly in
sequence, never two sources' write-ups in flight at once. (This was
previously 2-at-a-time; reverted to 1 after repeated rate-limit/stalled-
connection issues against this Azure deployment made the parallelism more
trouble than it was worth — see SOURCE_MAX_CONCURRENCY in agent.py and
AZURE_HTTP_TIMEOUT in rate_limit.py for the actual incident fixes.) Each
source's own text is still internally chunked if long (same ~12k-char
chunking as before, now scoped to one source instead of the whole combined
blob) — a source's multi-chunk write-up runs its chunks SEQUENTIALLY
against each other (chunk N revises what chunk N-1 produced), since
independent parallel chunk calls can't compose cleanly against one shared
base document.

Each source is drafted against the ORIGINAL existing document (not against
a prior source's in-progress output), then all N drafts are combined via a
PAIRWISE TOURNAMENT merge (see _tournament_merge): round 1 merges disjoint
pairs of drafts, halving the document count each round, until one document
remains. With _SOURCE_CONCURRENCY=1 this merge phase also runs one pair at
a time rather than truly in parallel, but the O(log N) round structure
still means fewer total merge calls than a fully flat one-at-a-time chain
for entries with several sources.
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv

load_dotenv()

import httpx
from pydantic import BaseModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.settings import ModelSettings
from pydantic_ai import Agent

from cost_guard import CostGuardModel, run_scope
from .definition import CLARIFY_INSTRUCTIONS, CLARIFY_SOUL, DOCUMENT_INSTRUCTIONS, DOCUMENT_SOUL
from ..rate_limit import AZURE_HTTP_TIMEOUT, LLM_CONCURRENCY, retry_on_rate_limit

# Gates how many sources (not LLM calls) can be drafting at once — a
# SEPARATE semaphore from LLM_CONCURRENCY (not just the same limit reused),
# since a multi-chunk source's draft holds this one for its whole lifetime
# while also acquiring/releasing LLM_CONCURRENCY per chunk internally;
# sharing one semaphore for both would self-deadlock (a source already
# holding its only slot can never acquire a second one for its own first
# chunk call). Defaults to 1 (strictly one source evaluated at a time) —
# repeated rate-limit/stall issues against this Azure deployment made
# source-level parallelism more trouble than it was worth; override via env
# if the deployment's quota is later raised enough to make 2+ worthwhile
# again.
_SOURCE_CONCURRENCY = asyncio.Semaphore(int(os.environ.get("SOURCE_MAX_CONCURRENCY", "1")))


class RawSource(BaseModel):
    """One source's text paired with a short label (filename or repo name)
    — the label is only used for progress reporting (see _report_progress);
    generation itself only ever reads `text`.
    """
    label: str
    text: str


async def _report_progress(api_base_url: str, session_id: str, message: str) -> None:
    """Posts a one-line, in-progress status update into the session's chat
    (NestJS's POST /sessions/:id/progress — see sessions.service.ts). Best-
    effort: a progress line is a nice-to-have, never worth failing or
    retrying the actual generation over, so any error here is swallowed.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{api_base_url}/sessions/{session_id}/progress", json={"message": message})
    except Exception:
        pass

_model = CostGuardModel(
    OpenAIChatModel(
        os.environ.get("AZURE_LLM_DEPLOYMENT_NAME", "gpt-4.1"),
        provider=AzureProvider(
            azure_endpoint=os.environ["AZURE_LLM_ENDPOINT"],
            api_key=os.environ["AZURE_LLM_API_KEY"],
            api_version=os.environ.get("AZURE_LLM_API_VERSION", "2024-12-01-preview"),
            http_client=httpx.AsyncClient(timeout=AZURE_HTTP_TIMEOUT),
        ),
    ),
    agent="stories",
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
        with run_scope():
            result = await retry_on_rate_limit(lambda: document_agent.run(prompt))
    return result.output.content_html


async def generate_document(
    session_id: str,
    api_base_url: str,
    existing_document_html: str,
    raw_sources: list[RawSource],
    entry_label: str,
    clarification: str | None = None,
) -> str:
    """Generates (if existing_document_html is empty) or revises (if
    non-empty) one entry's detailed document from its raw tagged sources.
    entry_label is a human-readable name (e.g. "Dell — Software Engineer")
    for the prompt; the entry's identity has already been pinned by
    whoever called this. `clarification` is the user's answer to a question
    _check_for_clarification asked earlier this session, if any — folded in
    as its own source ahead of the rest. Returns the full document HTML.

    Drafts each source independently (bounded to 2 concurrent drafts by
    LLM_CONCURRENCY), then combines the drafts via a pairwise tournament
    merge (see module docstring and _tournament_merge) — never two merges
    racing to update the same shared document, but only O(log N) sequential
    rounds rather than O(N) sequential merges for an entry with many
    sources. Reports one-line progress updates into the session's chat
    (session_id/api_base_url) as each source starts/finishes and as each
    merge round starts/finishes.
    """
    sources = list(raw_sources)
    if clarification and clarification.strip():
        sources = [
            RawSource(label="your answer", text=(
                f"User-provided clarification (answers a question asked about "
                f"this entry's source material): {clarification}"
            )),
            *sources,
        ]
    sources = [s for s in sources if s.text.strip()]
    if not sources:
        # Nothing new to fold in — leave the existing document (if any) as-is
        # rather than asking the model to revise against empty source text.
        return existing_document_html

    if len(sources) == 1:
        source = sources[0]
        await _report_progress(api_base_url, session_id, f"Evaluating {source.label}...")
        result = await _draft_from_source(
            existing_document_html, source.text, entry_label, source.label, api_base_url, session_id,
        )
        await _report_progress(api_base_url, session_id, f"{source.label} done")
        return result

    # Multiple sources: draft each source's contribution against the
    # original existing_document_html (not against another source's
    # in-progress output), gated by _SOURCE_CONCURRENCY — a separate
    # semaphore from LLM_CONCURRENCY (_draft_from_source's own chunk calls
    # acquire LLM_CONCURRENCY internally, so reusing the same semaphore here
    # would self-deadlock a multi-chunk source holding its own slot while
    # trying to acquire a second one for its first chunk). Defaults to 1, so
    # in practice this runs strictly one source at a time; asyncio.gather is
    # still used so this scales back up cleanly if the limit is ever raised
    # via SOURCE_MAX_CONCURRENCY. The "Evaluating..." announcement happens
    # AFTER acquiring a slot (not before), so the chat reflects what's
    # actually running right now rather than every source announcing at
    # once while most are really just queued.
    async def draft_one(source: RawSource) -> str:
        async with _SOURCE_CONCURRENCY:
            await _report_progress(api_base_url, session_id, f"Evaluating {source.label}...")
            result = await _draft_from_source(
                existing_document_html, source.text, entry_label, source.label, api_base_url, session_id,
            )
        await _report_progress(api_base_url, session_id, f"{source.label} done")
        return result

    drafts = await asyncio.gather(*(draft_one(source) for source in sources))

    # Combine the N independent drafts via a pairwise TOURNAMENT merge
    # rather than one long chain: round 1 merges drafts in disjoint pairs
    # (still gated by _SOURCE_CONCURRENCY, so one pair/merge at a time by
    # default), halving the document count; round 2 merges the survivors'
    # pairs, and so on until one document remains. Never merges two
    # documents into the SAME base simultaneously (each merge combines two
    # independent, already-complete documents — never two merges racing to
    # update one shared running document), and needs only O(log N)
    # sequential rounds instead of O(N) sequential merge calls even at
    # concurrency 1 — for a 4-source entry, 2 merge rounds instead of 4.
    labels = [s.label for s in sources]
    return await _tournament_merge(drafts, labels, entry_label, api_base_url, session_id)


async def _tournament_merge(
    documents: list[str], labels: list[str], entry_label: str, api_base_url: str, session_id: str,
) -> str:
    current_round = documents
    current_labels = labels
    while len(current_round) > 1:
        pairs = [current_round[i : i + 2] for i in range(0, len(current_round), 2)]
        label_pairs = [current_labels[i : i + 2] for i in range(0, len(current_labels), 2)]

        async def merge_pair(pair: list[str], label_pair: list[str]) -> tuple[str, str]:
            if len(pair) == 1:
                return pair[0], label_pair[0]
            merged_label = " + ".join(label_pair)
            async with _SOURCE_CONCURRENCY:
                await _report_progress(api_base_url, session_id, f"Merging {merged_label}...")
                result = await _merge_documents(pair[0], pair[1], entry_label)
            await _report_progress(api_base_url, session_id, f"Merge of {merged_label} done")
            return result, merged_label

        results = await asyncio.gather(
            *(merge_pair(pair, label_pair) for pair, label_pair in zip(pairs, label_pairs))
        )
        current_round = [r[0] for r in results]
        current_labels = [r[1] for r in results]
    return current_round[0]


async def _draft_from_source(
    existing_html: str,
    source_text: str,
    entry_label: str,
    source_label: str,
    api_base_url: str,
    session_id: str,
) -> str:
    """Produces one source's standalone draft of the document — still
    chunked internally (sequential fold) if that one source's text alone is
    long, same shape as before (now scoped per-source rather than
    per-combined-blob). When there's only one source overall, this IS the
    final document; with multiple sources, each one's draft is merged
    afterward (see _tournament_merge) rather than compared against siblings.

    A large source (e.g. a multi-tab/multi-section document extracting to
    hundreds of thousands of characters) can need dozens of chunks, each its
    own sequential LLM call — with only a per-source "Evaluating..." line,
    that looked identical to a genuine hang for 15-20+ minutes on a real
    35-chunk file. Reports "X (chunk N of M)..." progress per chunk so a
    large file's processing stays visibly incremental instead of silent.
    """
    if len(source_text) <= _CHUNK_SIZE_CHARS:
        return await _generate_or_revise_chunk(existing_html, source_text, 0, 1, entry_label)

    chunks = _chunk_text(source_text)
    current_html = existing_html
    for i, chunk in enumerate(chunks):
        if len(chunks) > 1:
            await _report_progress(
                api_base_url, session_id, f"{source_label} (chunk {i + 1} of {len(chunks)})..."
            )
        current_html = await _generate_or_revise_chunk(current_html, chunk, i, len(chunks), entry_label)
    return current_html


async def _merge_documents(document_a: str, document_b: str, entry_label: str) -> str:
    """Combines two independent, already-complete documents (each already
    incorporating one or more sources) into one — symmetric, not "current +
    new draft": used both for merging two single-source drafts and for
    merging two already-merged multi-source documents in a later tournament
    round, so the same function composes at every level of the merge tree.
    """
    prompt = (
        f"Entry: {entry_label}\n\n"
        f"## Document A (preserve everything in it not contradicted/"
        f"extended by Document B)\n{document_a or '[empty]'}\n\n"
        f"## Document B (preserve everything in it not contradicted/"
        f"extended by Document A)\n{document_b or '[empty]'}\n\n"
        f"Combine these into ONE document covering everything both contain. "
        f"They describe the same entry from different sources, so treat "
        f"overlapping material as confirming the same facts (merge into one "
        f"statement, don't duplicate) and only resolve a genuine "
        f"contradiction between them — never drop unique material from "
        f"either side."
    )
    async with LLM_CONCURRENCY:
        with run_scope():
            result = await retry_on_rate_limit(lambda: document_agent.run(prompt))
    return result.output.content_html


async def _check_for_clarification(
    existing_document_html: str, raw_sources: list[RawSource], entry_label: str,
) -> str | None:
    """One small, cheap call deciding whether the source material has a
    genuine, resolvable gap/contradiction worth asking the user about before
    writing starts. Returns the question text, or None if generation should
    just proceed. Deliberately separate from document_agent/generate_document
    — this never needs chunking (it's a yes/no-plus-one-question judgment
    over a summary of the material, not a full write-up) and must stay cheap
    even for large source sets.
    """
    combined_source = "\n\n---\n\n".join(s.text for s in raw_sources if s.text.strip())
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
            with run_scope():
                result = await clarify_agent.run(prompt)
    except Exception:
        return None
    output = result.output
    return output.question if output.has_question and output.question.strip() else None


async def run_entry_document_turn(
    session_id: str,
    api_base_url: str,
    existing_document_html: str,
    raw_sources: list[RawSource],
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

    content_html = await generate_document(
        session_id, api_base_url, existing_document_html, raw_sources, entry_label, user_reply,
    )
    return True, content_html, None
