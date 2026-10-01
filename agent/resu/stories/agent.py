"""Story Extraction Agent instance + entry point.

Single structured-output call per source (one document or one GitHub repo) —
not a multi-turn chat. Low-confidence attribution surfaces as a flagged
candidate for the user to resolve in the review UI, rather than as an
in-chat clarifying question.
"""
from __future__ import annotations

import os
from typing import Literal

from dotenv import load_dotenv

load_dotenv()

from pydantic import BaseModel
from pydantic_ai import Agent
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


class StoryExtractionOutput(BaseModel):
    candidates: list[StoryCandidateOut]


_SYSTEM_PROMPT = f"{SOUL}\n\n{IDENTITY}\n\n{INSTRUCTIONS}"

stories_agent = Agent(
    model=_model,
    deps_type=StoriesDeps,
    output_type=StoryExtractionOutput,
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


async def extract_stories(
    raw_text: str,
    source_type: str,
    source_label: str,
    entries: dict,
    api_base_url: str,
) -> StoryExtractionOutput:
    entries_block = _render_entries_for_matching(entries)
    prompt = (
        f"Source type: {source_type}\n"
        f"Source label: {source_label}\n\n"
        f"## Candidate's structured entries (match source text against these)\n{entries_block}\n\n"
        f"## Source text to attribute\n{raw_text}"
    )
    result = await stories_agent.run(prompt, deps=StoriesDeps(api_base_url=api_base_url))
    return result.output
