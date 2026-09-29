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
    fetch_candidate_stories,
    fetch_connected_repo_readmes,
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
    "the user's Stories (detailed work-experience narratives) and existing Resume "
    "(formatting reference only), you produce one fully tailored, ATS-optimized "
    "resume for that specific role."
)

INSTRUCTIONS = (
    "Always call fetch_job_description for the application you were asked about, "
    "and fetch_candidate_stories / fetch_candidate_resume for source material — "
    "your profile facts and process template are already provided below. Also "
    "call fetch_connected_repo_readmes — if the candidate has connected GitHub "
    "repos, their READMEs are real, verifiable project material worth pulling "
    "into project/internship bullets alongside Stories; an empty result just "
    "means none are connected, not an error.\n\n"
    "Before writing anything: check the JD against the candidate's disqualifier "
    "keywords and max-years-experience cutoff from the profile facts below. If the "
    "JD clearly fails either, say so plainly and stop rather than generating a "
    "resume anyway.\n\n"
    "Follow the process template below exactly, in order. Treat Stories as the "
    "primary source of truth for content and the uploaded Resume strictly as a "
    "formatting reference — never invent facts not grounded in Stories or the "
    "structured entries below."
)


def build_profile_context(profile: dict, entries: dict | None = None) -> str:
    """Renders the candidate's profile facts + structured entries + process
    template as a prompt fragment. Called fresh on every agent run (see
    agent.py's system_prompt hook) so edits in Settings apply immediately with
    no restart.
    """
    facts = "\n".join(
        f"- {label}: {value}"
        for label, value in [
            ("Target role archetype", profile.get("targetRoleArchetype")),
            ("Disqualifier keywords", ", ".join(profile.get("disqualifierKeywords") or [])),
            ("Location / zip", profile.get("locationZip")),
            ("Max years experience cutoff", profile.get("maxYearsExperience")),
            ("ATS match score target", f"{profile.get('matchScoreTarget', 93)}%"),
        ]
        if value
    )

    entries_section = _render_entries(entries) if entries else ""

    return (
        f"## Candidate profile facts\n{facts}\n\n"
        f"{entries_section}"
        f"## Process template\n{profile.get('templateBody', '')}"
    )


def _render_entries(entries: dict) -> str:
    """Renders work experience/education/internships/projects, split into
    required (must appear) vs optional (include only if relevant to the JD).
    """

    def render_group(label: str, items: list[dict], line_fn) -> str:
        if not items:
            return ""
        required = [line_fn(i) for i in items if i.get("required")]
        optional = [line_fn(i) for i in items if not i.get("required")]
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
        entries.get("workExperience", []),
        lambda e: f"{e['company']}"
        + (f" — {e['title']}" if e.get("title") else "")
        + f" ({e.get('yearIn', '?')}–{e.get('yearOut') or 'present'})",
    )
    education = render_group(
        "Education",
        entries.get("education", []),
        lambda e: f"{e['school']}"
        + (f" — {e['degree']}" if e.get("degree") else "")
        + (f" ({e['year']})" if e.get("year") else ""),
    )
    internships = render_group(
        "Internships",
        entries.get("internships", []),
        lambda e: f"{e['company']}" + (f" ({e['year']})" if e.get("year") else ""),
    )
    projects = render_group(
        "Projects",
        entries.get("projects", []),
        lambda e: f"{e['name']}"
        + (f" — {e['repoUrl']}" if e.get("repoUrl") else "")
        + (f" — live: {e['liveUrl']}" if e.get("liveUrl") else "")
        + (f" ({e['year']})" if e.get("year") else ""),
    )

    return f"## Candidate background\n\n{work}{education}{internships}{projects}"


TOOLS = [
    fetch_candidate_profile,
    fetch_structured_entries,
    fetch_job_description,
    fetch_candidate_stories,
    fetch_candidate_resume,
    fetch_connected_repo_readmes,
]
