"""Referral-request pipeline: one resume for several job descriptions, ATS-checked
against each, plus a referral message in a chosen tone.

Runs unattended (no clarifying questions) as a single cost-guard run, so the
whole thing shows up as one run on the /llm-usage page. The resume itself is
produced by the existing resu_agent (agent label "resu"); the independent ATS
scorer and the message writer use agent label "referral".

Progress lines go to the session's chat via NestJS's /sessions/:id/progress.
"""
from __future__ import annotations

import asyncio
import re
from typing import Literal

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent

from cost_guard import BudgetExceededError, CostGuardModel, run_scope

from ..agent import StructuredResume, _model as _resu_model, resu_agent
from ..deps import ResuDeps
from ..rate_limit import LLM_CONCURRENCY, retry_on_rate_limit
from ..stories.agent import _report_progress

ATS_TARGET = 90
# The first draft plus up to two ATS-feedback revisions.
MAX_DRAFTS = 3

Tone = Literal["friend", "colleague", "acquaintance", "mentor"]

_TONE_GUIDE: dict[str, str] = {
    "friend": "Warm, casual and personal — the way you'd text a friend. First name, relaxed phrasing, a touch of humour is fine.",
    "colleague": "Friendly but professional — someone you've worked alongside. Reference shared work context lightly; direct and efficient.",
    "acquaintance": "Polite and slightly formal — someone you know only a little. Briefly remind them how you're connected, keep it low-pressure and make it easy to say no.",
    "mentor": "Respectful and appreciative — someone who has guided you. Acknowledge their time and advice, and ask for a referral as a favour you'd understand them declining.",
}


class RoleInput(BaseModel):
    id: str
    title: str
    url: str
    jd_text: str


class RoleScore(BaseModel):
    role_id: str
    title: str
    score: int
    missing: list[str]


class ReferralResult(BaseModel):
    message: str
    resume: StructuredResume
    scores: list[RoleScore]
    target_met: bool
    note: str | None = None


class AtsScore(BaseModel):
    score: int
    missing_keywords: list[str]


class ReferralMessage(BaseModel):
    body: str


# Same underlying deployment as resume generation, but labelled "referral" on
# the usage page for the scorer/writer calls.
_ref_model = CostGuardModel(_resu_model.wrapped, agent="referral")

_scorer = Agent(
    model=_ref_model,
    output_type=AtsScore,
    system_prompt=(
        "You are an ATS (applicant tracking system) match scorer. Given a resume and ONE job "
        "description, return `score` (integer 0-100): how well the resume matches the JD on "
        "required skills/keywords, preferred skills, seniority and years of experience, and "
        "domain. Be realistic, not generous — 90+ means it would clearly rank near the top of "
        "the applicant pool, and requirements the resume doesn't demonstrably cover must pull "
        "the score down. Also return `missing_keywords`: up to 10 specific skills, tools or "
        "requirements from the JD that the resume lacks or only weakly shows (most important "
        "first); empty if none."
    ),
)

_writer = Agent(
    model=_ref_model,
    output_type=ReferralMessage,
    system_prompt=(
        "You write short messages asking someone at a company for a job referral. Output the "
        "complete message as plain text in `body` (no subject line, no markdown). Rules: open "
        "with a greeting using the recipient's first name; keep it under ~150 words; say a "
        "resume is attached; include EVERY job link given, verbatim, each on its own line; "
        "make one or two specific, truthful points about why the candidate fits, drawn only "
        "from the resume text provided — never invent experience, employers, or relationships "
        "or shared history; make a clear but easy-to-decline ask; end with the candidate's name. "
        "Match the requested tone exactly."
    ),
)

_NO_QUESTIONS = (
    "This is an automated run and nobody can answer questions. Make the most reasonable "
    "assumption for anything unclear and finish now: return the complete resume with done=true."
)


def resume_to_text(resume: StructuredResume) -> str:
    lines = [resume.contactLine]
    for section in resume.sections:
        lines.append(f"\n{section.heading.upper()}")
        for e in section.entries:
            head = " — ".join(x for x in [e.name, e.subtitle, e.dateRange, e.location] if x)
            lines.append(head)
            lines.extend(f"- {b}" for b in e.bullets)
    return re.sub(r"\*\*", "", "\n".join(lines))


async def _generate(
    prompt: str, history: list | None, deps: ResuDeps
) -> tuple[StructuredResume, list]:
    result = await retry_on_rate_limit(
        lambda: resu_agent.run(prompt, deps=deps, message_history=history)
    )
    output, history = result.output, result.all_messages()
    if not output.done or output.resume is None:
        # The agent stopped to ask something — nobody's there to answer.
        result = await retry_on_rate_limit(
            lambda: resu_agent.run(_NO_QUESTIONS, deps=deps, message_history=history)
        )
        output, history = result.output, result.all_messages()
        if not output.done or output.resume is None:
            raise RuntimeError(f"Resume agent could not finish the resume: {output.question or 'no output'}")
    return output.resume, history


async def _score_one(resume_text: str, role: RoleInput) -> RoleScore:
    async with LLM_CONCURRENCY:
        result = await retry_on_rate_limit(
            lambda: _scorer.run(
                f"## Resume\n{resume_text}\n\n## Job description — {role.title}\n{role.jd_text[:12000]}"
            )
        )
    return RoleScore(
        role_id=role.id,
        title=role.title,
        score=max(0, min(100, int(result.output.score))),
        missing=result.output.missing_keywords[:10],
    )


def _first_draft_prompt(company: str, roles: list[RoleInput]) -> str:
    jds = "\n\n---\n\n".join(f"## Job description {i}: {r.title}\n{r.jd_text[:12000]}" for i, r in enumerate(roles, 1))
    return (
        f"Generate ONE resume for the candidate that is tailored to ALL {len(roles)} of the "
        f"following {company} job descriptions at once — a single resume that would score at "
        f"least {ATS_TARGET}% ATS match on EACH of them. For this run the ATS target is "
        f"{ATS_TARGET}% on every JD (overriding any other target in your instructions). Cover "
        "the skills and keywords the JDs share first, then each JD's specific ones, but only "
        "where the candidate's real background supports them — never fabricate experience. "
        "This is an automated run: if you would normally ask a clarifying question, make the "
        "most reasonable assumption and finish with done=true.\n\n" + jds
    )


def _revision_prompt(scores: list[RoleScore]) -> str:
    lines = []
    for s in scores:
        gaps = ", ".join(s.missing) if s.missing else "none listed"
        flag = "OK" if s.score >= ATS_TARGET else "BELOW TARGET"
        lines.append(f"- {s.title}: {s.score}% ({flag}); missing/weak: {gaps}")
    return (
        f"An independent ATS check of your last resume found:\n" + "\n".join(lines) + "\n\n"
        f"Revise the resume so EVERY job description reaches at least {ATS_TARGET}%. Work the "
        "missing keywords and requirements in only where the candidate's background genuinely "
        "supports them (reword bullets, reorder, surface relevant entries or projects) — never "
        "invent experience. Keep the scores that are already OK from dropping. Return the "
        "complete revised resume with done=true."
    )


def _ensure_links(body: str, roles: list[RoleInput]) -> str:
    missing = [r for r in roles if r.url not in body]
    if not missing:
        return body
    extra = "\n".join(f"{r.title}: {r.url}" for r in missing)
    return f"{body.rstrip()}\n\n{extra}"


async def _candidate_name(api_base_url: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{api_base_url}/resumes/profile")
            resp.raise_for_status()
            return resp.json().get("candidateName") or ""
    except Exception:
        return ""


async def run_referral(
    session_id: str,
    api_base_url: str,
    company: str,
    contact_name: str,
    tone: Tone,
    roles: list[RoleInput],
) -> ReferralResult:
    async def say(message: str) -> None:
        await _report_progress(api_base_url, session_id, message)

    deps = ResuDeps(api_base_url=api_base_url)
    best: tuple[StructuredResume, list[RoleScore]] | None = None
    stopped_early: str | None = None
    drafts_made = 0

    def quality(scores: list[RoleScore]) -> tuple[int, float]:
        return (min(s.score for s in scores), sum(s.score for s in scores) / len(scores))

    with run_scope():
        await say(f"Building one resume for {len(roles)} role(s) — target {ATS_TARGET}% ATS on each...")
        resume, history = await _generate(_first_draft_prompt(company, roles), None, deps)

        for draft in range(1, MAX_DRAFTS + 1):
            drafts_made = draft
            await say(f"Draft {draft}: checking ATS match against each job description...")
            try:
                scores = list(await asyncio.gather(*(_score_one(resume_to_text(resume), r) for r in roles)))
            except BudgetExceededError as exc:
                stopped_early = str(exc)
                break
            for s in scores:
                await say(f"  {s.title}: {s.score}%")
            if best is None or quality(scores) > quality(best[1]):
                best = (resume, scores)

            if all(s.score >= ATS_TARGET for s in scores):
                await say(f"All {len(roles)} role(s) are at or above {ATS_TARGET}%.")
                break
            if draft == MAX_DRAFTS:
                break

            gaps = sorted({k for s in scores if s.score < ATS_TARGET for k in s.missing})[:8]
            await say(
                f"Below {ATS_TARGET}% on at least one role — revising"
                + (f" (gaps: {', '.join(gaps)})" if gaps else "")
                + "..."
            )
            try:
                resume, history = await _generate(_revision_prompt(scores), history, deps)
            except BudgetExceededError as exc:
                stopped_early = str(exc)
                break

        if best is None:
            raise RuntimeError(stopped_early or "Could not score the resume")
        best_resume, best_scores = best

        await say(f"Drafting the {tone} referral message...")
        sender = await _candidate_name(api_base_url)
        written = await retry_on_rate_limit(
            lambda: _writer.run(
                f"Tone: {tone} — {_TONE_GUIDE[tone]}\n"
                f"Candidate (sender): {sender or '(name not set — sign off with just a thank you)'}\n"
                f"Recipient: {contact_name}, who works at {company}\n\n"
                "Roles and links to include:\n"
                + "\n".join(f"- {r.title}: {r.url}" for r in roles)
                + f"\n\nCandidate's resume (for truthful specifics only):\n{resume_to_text(best_resume)[:3500]}"
            )
        )
        message = _ensure_links(written.output.body.strip(), roles)

    target_met = all(s.score >= ATS_TARGET for s in best_scores)
    note: str | None = None
    if not target_met:
        below = "; ".join(
            f"{s.title}: {s.score}% (gaps: {', '.join(s.missing[:6]) or 'none listed'})"
            for s in best_scores
            if s.score < ATS_TARGET
        )
        note = (
            f"Couldn't reach {ATS_TARGET}% on every role after {drafts_made} draft(s) without "
            f"claiming experience your background doesn't show. Below target — {below}. The "
            "closest resume is attached; consider picking roles that overlap more, or add the "
            "missing skills to your entries if you genuinely have them."
        )
        if stopped_early:
            note += f" (Stopped early: {stopped_early}.)"
    await say("Done.")
    return ReferralResult(
        message=message, resume=best_resume, scores=best_scores, target_met=target_met, note=note
    )
