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
    portfolio = f"[Portfolio]({profile['portfolioUrl']})" if profile.get("portfolioUrl") else None
    parts = [
        profile.get("candidateEmail"),
        location or None,
        profile.get("candidatePhone"),
        profile.get("linkedinUrl"),
        profile.get("githubUrl"),
        portfolio,
    ]
    return " | ".join(p for p in parts if p)


def _entry_key(group: str, e: dict) -> str:
    if group == "education":
        return e.get("school") or ""
    if group == "projects":
        return e.get("name") or ""
    return e.get("company") or ""


def _match_entry(
    resume_name: str,
    entries: dict,
    subtitle: str | None = None,
    used: set[str] | None = None,
) -> tuple[str, dict] | None:
    """The Resume-tab entry a resume entry corresponds to. The same company can
    appear twice (a full-time role AND an MBA internship at Dell), so a name
    match alone is ambiguous: the title (the subtitle may add words or be
    retitled) and an MBA/intern hint break the tie, and entries already claimed
    by an earlier resume entry (`used`) are skipped."""
    rn = _norm(resume_name)
    if len(rn) < 3:
        return None
    sub = _norm(subtitle)
    hint = f"{resume_name} {subtitle or ''}".lower()
    candidates: list[tuple[int, str, dict]] = []
    for group in ("workExperience", "internships", "projects", "education"):
        for e in entries.get(group, []):
            if used is not None and e["id"] in used:
                continue
            en = _norm(_entry_key(group, e))
            if len(en) >= 3 and (rn in en or en in rn):
                score = 0
                title = _norm(e.get("title"))
                if title and title in sub:
                    score += 2
                if group == "internships" and re.search(r"mba|intern|consult", hint):
                    score += 1
                candidates.append((score, group, e))
    if not candidates:
        return None
    best = max(candidates, key=lambda c: c[0])  # max() keeps the first on ties
    if used is not None:
        used.add(best[2]["id"])
    return best[1], best[2]


def enforce_bullet_bounds(resume: StructuredResume, entries: dict) -> int:
    """Last-resort safety net: cut any entry over its own max bullets down to it
    (keeping the first bullets). Returns how many entries were trimmed."""
    trimmed = 0
    used: set[str] = set()
    for section in resume.sections:
        for entry in section.entries:
            found = _match_entry(entry.name, entries, entry.subtitle, used)
            if found and found[0] == "education":
                if entry.bullets and not found[1].get("isPresent"):
                    entry.bullets = []
                    trimmed += 1
                continue
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

            found = _match_entry(entry.name, entries, entry.subtitle, matched_ids)
            if not found:
                continue
            group, e = found
            if group == "education":
                if entry.bullets and not e.get("isPresent"):
                    problems.append(f"{label}: education has bullets but is not currently active — leave its bullets empty")
                continue
            if group == "projects":
                words = len((entry.subtitle or "").split())
                if words == 0:
                    problems.append(
                        f"{label}: add a 3-4 word description of the project in its subtitle "
                        '(e.g. "AI-Native predictive maintenance for Manufacturers")'
                    )
                elif words > 6:
                    problems.append(f'{label}: the project description in its subtitle is {words} words — keep it to 3-4')
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
