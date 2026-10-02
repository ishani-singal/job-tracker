"""Resu's AgentDefinition — soul, identity, instructions, tools.

No AgentDefinition wrapper is vendored in this standalone repo (per the new-agent
skill's cross-repo guidance, Section 9.1) — prompt strings are assembled directly
here and passed straight into Agent(...) in agent.py. Reintroduce the real
AgentDefinition wrapper when this is merged into Soma.

Resu has exactly one linear workflow (generate a tailored resume for a given
application) with no branching triggers, so it has no skills/Capabilities per the
new-agent skill's own guidance to skip them when there's no 2+ distinct
triggered behavior.
"""
from __future__ import annotations

from .tools import (
    fetch_candidate_profile,
    fetch_candidate_resume,
    fetch_company_job_descriptions,
    fetch_document_for_entry,
    fetch_job_description,
    fetch_structured_entries,
)

SOUL = (
    "You are Resu — precise, direct, and allergic to fluff. You write like someone "
    "who has read ten thousand resumes and knows exactly which sentence a hiring "
    "manager skips. Plain text only, no filler praise."
)

IDENTITY = (
    "You are the user's resume tailoring specialist. Given a job description and "
    "the candidate's structured background entries — each carrying its own Story "
    "(a detailed document the user generated and can hand-edit, covering "
    "whichever Stories/Resume file or GitHub repo they tagged to that entry, so "
    "it's already correctly scoped to that one entry) — and existing Resume "
    "(formatting reference only), you produce one fully tailored, ATS-optimized "
    "resume for that specific role."
)

INSTRUCTIONS = (
    "The job description(s) you are tailoring for are given in the user "
    "message. Your profile facts, process template, structured entries, and "
    "each entry's own Story are already provided below — you do not need to "
    "fetch any of them yourself, and should not call a tool unless the "
    "instructions below explicitly say to.\n\n"
    "Before writing anything: check the JD against the candidate's disqualifier "
    "keywords and max-years-experience cutoff from the profile facts below. If the "
    "JD clearly fails either, say so plainly and stop rather than generating a "
    "resume anyway.\n\n"
    "Follow the process template below exactly, in order. Each entry below "
    "carries its own Story directly inline — treat that Story as the primary, "
    "authoritative source for that entry specifically, and never pull content "
    "from one entry's Story into a different entry's bullets. An entry marked "
    "'Story: [none yet]' has no detailed document generated for it yet — for "
    "that entry only, you may call fetch_document_for_entry yourself if you "
    "suspect a document was generated after this prompt was built, but never "
    "invent facts not grounded in that entry's own Story."
)


def build_profile_context(
    profile: dict, entries: dict | None = None, stories: list[dict] | None = None
) -> str:
    """Renders the candidate's profile facts + structured entries (each
    carrying its own live-extracted Story inline) + process template as a
    prompt fragment. Called fresh on every agent run (see agent.py's
    system_prompt hook) so edits in Settings apply immediately with no
    restart.

    `stories` is built by agent.py's _fetch_all_documents, one GET
    /stories/document call per entry — each item {entryType, entryId,
    storyText}. Keying each entry's rendered line by its own (entryType,
    entryId) is the actual structural fix for the "model mixes content
    between entries" problem: each entry's block in the prompt carries only
    that entry's own story text, so there is no shared blob in context for
    the model to misattribute across entries.
    """
    location = ", ".join(
        part
        for part in [
            profile.get("locationCity"),
            profile.get("locationState"),
            profile.get("locationCountry"),
        ]
        if part
    )

    facts = "\n".join(
        f"- {label}: {value}"
        for label, value in [
            ("Target role archetype", profile.get("targetRoleArchetype")),
            ("Disqualifier keywords", ", ".join(profile.get("disqualifierKeywords") or [])),
            ("Location", location),
            ("Open to remote roles", "Yes" if profile.get("openToRemote") else None),
            ("Max years experience cutoff", profile.get("maxYearsExperience")),
            ("ATS match score target", f"{profile.get('matchScoreTarget', 93)}%"),
            ("Email", profile.get("candidateEmail")),
            ("Phone", profile.get("candidatePhone")),
            ("LinkedIn URL", profile.get("linkedinUrl")),
        ]
        if value
    )

    contact_parts = [
        profile.get("candidateEmail"),
        location or None,
        profile.get("candidatePhone"),
        profile.get("linkedinUrl"),
    ]
    contact_line_instruction = (
        "## Contact line\n"
        "Set `contactLine` to exactly these contact details, in this order, "
        "joined by \" | \" — omit any part whose value is missing, but keep the "
        "order. Do NOT include the candidate's name, target role, or "
        "\"Open to remote\" in this line — the name is rendered separately "
        "above it, and the other facts are not part of the contact line.\n"
        f"Contact line value: {' | '.join(p for p in contact_parts if p)}\n\n"
    )

    stories_by_entry = {
        (s["entryType"], s["entryId"]): s["storyText"] for s in (stories or [])
    }
    entries_section = _render_entries(entries, stories_by_entry) if entries else ""

    return (
        f"## Candidate profile facts\n{facts}\n\n"
        f"{contact_line_instruction}"
        f"{entries_section}"
        f"## Process template\n{profile.get('templateBody', '')}"
    )


def _bullet_bounds_suffix(e: dict) -> str:
    """Renders this specific entry's own bullet count bound (set per-entry in
    Settings, not shared across every entry of the same type) as a bracketed
    instruction appended to its line — overrides any bullet-count guidance in
    the process template below. Missing/null bounds render nothing, leaving
    that entry open-ended.
    """
    lo, hi = e.get("minBullets"), e.get("maxBullets")
    if lo is None and hi is None:
        return ""
    if lo is not None and hi is not None:
        return f" [BULLET COUNT: {lo}-{hi} bullets, required]"
    if lo is not None:
        return f" [BULLET COUNT: at least {lo} bullets, no upper bound, required]"
    return f" [BULLET COUNT: up to {hi} bullets, no lower bound, required]"


def _project_link_suffix(e: dict) -> str:
    """Resolves a project's hyperlink target — its repo URL if that repo is
    public (isRepoPublic, resolved once at save time by
    EntriesService.resolveRepoVisibility, not re-checked here), else its
    live/demo URL as a fallback, else no link at all. Rendered as a tag the
    model echoes into ResumeEntry.url verbatim.
    """
    repo_url, is_public = e.get("repoUrl"), e.get("isRepoPublic")
    if repo_url and is_public:
        return f" [LINK: {repo_url}]"
    fallback = e.get("liveUrl") or e.get("demoUrl")
    if fallback:
        return f" [LINK: {fallback}]"
    return ""


_MONTH_NAMES = [
    "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _format_date_range(e: dict) -> str:
    def fmt(month: int | None, year: int | None) -> str:
        if not year:
            return "?"
        return f"{_MONTH_NAMES[month]} {year}" if month else str(year)

    start = fmt(e.get("startMonth"), e.get("startYear"))
    end = "Present" if e.get("isPresent") else fmt(e.get("endMonth"), e.get("endYear"))
    return f"{start}–{end}"


def _render_entries(entries: dict, stories_by_entry: dict[tuple[str, str], str]) -> str:
    """Renders work experience/education/internships/projects, split into
    required (must appear) vs optional (include only if relevant to the JD).
    Each entry's own line carries its own live-extracted Story directly
    beneath it (or a "none yet" marker) — see build_profile_context's
    docstring for why this is the actual fix for cross-entry content mixing.
    """

    def story_line(entry_type: str, e: dict) -> str:
        story = stories_by_entry.get((entry_type, e["id"]))
        if story:
            return f"\n  Story: {story}"
        return "\n  Story: [none yet]"

    def render_group(label: str, entry_type: str, items: list[dict], line_fn) -> str:
        if not items:
            return ""
        required = [line_fn(i) + story_line(entry_type, i) for i in items if i.get("required")]
        optional = [
            line_fn(i) + story_line(entry_type, i) for i in items if not i.get("required")
        ]
        lines = []
        if required:
            lines.append(f"### {label} — required (must appear)")
            lines.extend(f"- {line}" for line in required)
        if optional:
            lines.append(
                f"### {label} — optional (include only if relevant to this JD)"
            )
            lines.extend(f"- {line}" for line in optional)
        return "\n".join(lines) + "\n\n" if lines else ""

    work = render_group(
        "Work Experience",
        "WORK_EXPERIENCE",
        entries.get("workExperience", []),
        lambda e: f"{e['company']}"
        + (f" — {e['title']}" if e.get("title") else "")
        + (f" ({e['location']})" if e.get("location") else "")
        + f" [{_format_date_range(e)}]"
        + (" [FAMILY BUSINESS — real scope/impact, but do not imply a formal "
           "competitive hiring process]" if e.get("isFamilyBusiness") else "")
        + (" [RETITLE ALLOWED — you may change this entry's job title on the "
           "generated resume if a different title would better fit the "
           "target role; flag the change to the user]" if e.get("allowRetitle")
           else " [RETITLE NOT ALLOWED — keep this entry's title exactly as "
           "given, even if a different title would fit the role better]")
        + _bullet_bounds_suffix(e),
    )
    education = render_group(
        "Education",
        "EDUCATION",
        entries.get("education", []),
        lambda e: f"{e['school']}"
        + (f" — {e['degree']}" if e.get("degree") else "")
        + (f" in {e['field']}" if e.get("field") else "")
        + (f" ({e['location']})" if e.get("location") else "")
        + f" [{_format_date_range(e)}]",
    )
    internships = render_group(
        "Internships",
        "INTERNSHIP",
        entries.get("internships", []),
        lambda e: f"{e['company']}"
        + (f" — {e['title']}" if e.get("title") else "")
        + (f" ({e['location']})" if e.get("location") else "")
        + f" [{_format_date_range(e)}]"
        + (" [CLASS PROJECT — a course project sponsored by this company, not a "
           "real internship hire; use project/coursework framing, not employment "
           "language]" if e.get("isClassProject") else "")
        + (" [FAMILY BUSINESS — real scope/impact, but do not imply a formal "
           "competitive hiring process]" if e.get("isFamilyBusiness") else "")
        + _bullet_bounds_suffix(e),
    )
    projects = render_group(
        "Projects",
        "PROJECT",
        entries.get("projects", []),
        lambda e: f"{e['name']}"
        + (f" — {e['repoUrl']}" if e.get("repoUrl") else "")
        + (f" — live: {e['liveUrl']}" if e.get("liveUrl") else "")
        + (f" ({e['location']})" if e.get("location") else "")
        + f" [{_format_date_range(e)}]"
        + _bullet_bounds_suffix(e)
        + _project_link_suffix(e),
    )

    return f"## Candidate background\n\n{work}{education}{internships}{projects}"


# Everything else (profile, entries, stories, JDs) is already in the prompt or
# user message — each extra tool round trip re-sends the whole ~50k+ token
# context, so only the one genuinely-needed fallback stays.
TOOLS = [fetch_document_for_entry]
