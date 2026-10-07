"""Bullet coherence review: flags resume bullets that are strings of keywords or
buzzwords rather than a sentence that makes sense on its own.

The guidelines already say a bullet "should make sense as a project from start to
end and not be buzzword filled", but ATS-driven revisions (work the missing JD
keywords in) push models toward keyword-stuffing, and nothing checked it. This
runs a small reviewer over the finished bullets; callers feed any issues back to
the resume agent as a targeted rewrite request.

Best effort by design: if the review itself fails, the resume is left as is.
"""
from __future__ import annotations

import re

from pydantic import BaseModel
from pydantic_ai import Agent

from cost_guard import CostGuardModel

from .agent import StructuredResume, _model as _resu_model
from .rate_limit import retry_on_rate_limit

MAX_ISSUES = 8


class BulletIssue(BaseModel):
    entry: str
    # The first ~8 words of the bullet, enough to find it.
    bullet_start: str
    problem: str


class BulletReview(BaseModel):
    issues: list[BulletIssue]


_review_model = CostGuardModel(_resu_model.wrapped, agent="bullet-review")

_reviewer = Agent(
    model=_review_model,
    output_type=BulletReview,
    system_prompt=(
        "You review resume bullets for coherence. A good bullet is ONE clear, grammatical sentence a "
        "hiring manager understands on first read: a concrete action, how it was done, and what it "
        "achieved. Flag a bullet when: it is mostly a string of keywords, tools or buzzwords rather "
        "than a sentence; it tacks on a tail of unrelated jargon (e.g. 'using A, B, C, and D') that "
        "isn't tied to the action; buzzwords are stacked without work behind them ('AI-native, "
        "scalable, cross-functional'); it never says what was actually done or what came of it; a "
        "metric has no context; or the grammar breaks so it doesn't read as a sentence. Do NOT flag "
        "a bullet merely for being dense, technical or full of real, relevant terms — only when the "
        "terms replace meaning. Return the worst offenders first, at most "
        f"{MAX_ISSUES}; return an empty list if every bullet is fine. For each issue give the entry "
        "name, the first ~8 words of the bullet, and a one-line problem."
    ),
)


def _bullets_text(resume: StructuredResume) -> str:
    lines: list[str] = []
    for section in resume.sections:
        for entry in section.entries:
            if not entry.bullets:
                continue
            lines.append(f"## {entry.name or section.heading}")
            for bullet in entry.bullets:
                lines.append("- " + bullet.replace("**", ""))
    return "\n".join(lines)


async def review_bullets(resume: StructuredResume) -> list[BulletIssue]:
    """Bullets that don't make sense on their own; [] if all fine (or the review failed)."""
    text = _bullets_text(resume)
    if not text:
        return []
    try:
        result = await retry_on_rate_limit(lambda: _reviewer.run(text))
        return result.output.issues[:MAX_ISSUES]
    except Exception:
        return []


def issue_lines(issues: list[BulletIssue]) -> list[str]:
    return [f'{i.entry}: "{i.bullet_start.strip()}..." — {i.problem.strip()}' for i in issues]


def quality_fix_prompt(lines: list[str]) -> str:
    return (
        "A reviewer found these bullets read as strings of keywords/buzzwords or don't make sense on "
        "their own:\n"
        + "\n".join(f"- {line}" for line in lines)
        + "\n\nRewrite ONLY those bullets and leave every other bullet exactly as it is. Each rewritten "
        "bullet must be one coherent sentence: a concrete action, how it was done, and a measurable "
        "outcome. Keep a job-description keyword only where it naturally describes what was actually "
        "done — drop it rather than forcing or listing it — and never add facts that the entry's Story "
        "doesn't support. Every other rule still applies (30 words or fewer, bullet-count ceilings, "
        "formatting, bolding). Return the complete resume with done=true."
    )
