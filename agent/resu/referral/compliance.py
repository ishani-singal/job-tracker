"""Deterministic checks of the resume guidelines that can be verified in code
(the rest — STAR structure, keyword wording, bolding — stay with the model).

The same rules the single-application flow gives the resume agent (see
agent/resu/definition.py and the user's process template): a hard ceiling on
bullet length, per-entry bullet-count bounds, dollar-figure formatting, no
leading bullet glyphs, required entries present, no retitling of entries that
disallow it, and the exact contact line. The referral pipeline runs these after
every draft and feeds any violations back as a revision request.
"""
from __future__ import annotations

import re

from ..agent import StructuredResume

MAX_BULLET_WORDS = 30

_LEADING_GLYPH = re.compile(r"^\s*(?:[•·▪◦‣\-–—]|\*(?!\*))\s")
_PLUS_SUFFIX = re.compile(r"\$\s?[\d.,]+\s?[KMB]?\+")
_COMMA_NUMBER = re.compile(r"\$\s?\d{1,3}(?:,\d{3})+")
_TILDE_DOLLAR = re.compile(r"~\s?\$")
_TITLE_ANNOTATION = re.compile(r"->|→|\bwas:|\bformerly\b|\(now\b", re.IGNORECASE)


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def expected_contact_line(profile: dict) -> str:
    """Same value build_profile_context tells the agent to use verbatim."""
    location = ", ".join(
        p for p in [profile.get("locationCity"), profile.get("locationState"), profile.get("locationCountry")] if p
    )
    parts = [profile.get("candidateEmail"), location or None, profile.get("candidatePhone"), profile.get("linkedinUrl")]
    return " | ".join(p for p in parts if p)


def _entry_key(group: str, e: dict) -> str:
    if group == "education":
        return e.get("school") or ""
    if group == "projects":
        return e.get("name") or ""
    return e.get("company") or ""


def _match_entry(resume_name: str, entries: dict) -> tuple[str, dict] | None:
    rn = _norm(resume_name)
    if len(rn) < 3:
        return None
    for group in ("workExperience", "internships", "projects", "education"):
        for e in entries.get(group, []):
            en = _norm(_entry_key(group, e))
            if len(en) >= 3 and (rn in en or en in rn):
                return group, e
    return None


def enforce_bullet_bounds(resume: StructuredResume, entries: dict) -> int:
    """Last-resort safety net: cut any entry over its own max bullets down to it
    (keeping the first bullets). Returns how many entries were trimmed."""
    trimmed = 0
    for section in resume.sections:
        for entry in section.entries:
            found = _match_entry(entry.name, entries)
            hi = found[1].get("maxBullets") if found else None
            if hi is not None and len(entry.bullets) > hi:
                entry.bullets = entry.bullets[:hi]
                trimmed += 1
    return trimmed


def check_resume(resume: StructuredResume, entries: dict, profile: dict) -> list[str]:
    """Violations of the checkable guidelines; empty when the resume complies."""
    problems: list[str] = []
    matched_ids: set[str] = set()

    for section in resume.sections:
        for entry in section.entries:
            label = entry.name

            for bullet in entry.bullets:
                words = len(re.sub(r"\*\*", "", bullet).split())
                if words > MAX_BULLET_WORDS:
                    problems.append(
                        f'{label}: a bullet is {words} words (max {MAX_BULLET_WORDS}, must fit 1-2 lines): '
                        f'"{" ".join(bullet.split()[:8])}..."'
                    )
                if _LEADING_GLYPH.match(bullet):
                    problems.append(f'{label}: a bullet starts with a bullet character ("{bullet[:12]}...") — the renderer adds its own')
                for pattern, why in (
                    (_PLUS_SUFFIX, 'a dollar figure has a "+" suffix'),
                    (_COMMA_NUMBER, "a dollar figure is written out with commas — use K/M/B shorthand"),
                    (_TILDE_DOLLAR, 'a dollar figure has a "~" prefix'),
                ):
                    if pattern.search(bullet):
                        problems.append(f"{label}: {why}")

            found = _match_entry(entry.name, entries)
            if not found:
                continue
            group, e = found
            matched_ids.add(e["id"])
            n = len(entry.bullets)
            lo, hi = e.get("minBullets"), e.get("maxBullets")
            if hi is not None and n > hi:
                problems.append(f"{label}: {n} bullets, but the ceiling is {hi} — cut to {hi}")
            if lo is not None and n < lo:
                problems.append(f"{label}: {n} bullets, but the minimum is {lo}")
            if group == "workExperience":
                subtitle = entry.subtitle or ""
                if _TITLE_ANNOTATION.search(subtitle) and not _TITLE_ANNOTATION.search(e.get("title") or ""):
                    problems.append(f'{label}: the title shows a change annotation ("{subtitle}") — show only one title')
                elif not e.get("allowRetitle") and _norm(subtitle) != _norm(e.get("title")):
                    problems.append(f'{label}: the title was changed but this entry is RETITLE NOT ALLOWED — use "{e.get("title")}"')

    for group in ("workExperience", "internships", "projects", "education"):
        for e in entries.get(group, []):
            if e.get("required") and e["id"] not in matched_ids:
                problems.append(f'Required entry missing from the resume: {_entry_key(group, e)}')

    return problems
