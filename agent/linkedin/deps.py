"""LinkedinDeps — local stand-in for Soma's SomaDeps, same shape as resu/deps.py.

No application_id here — this agent is whole-candidate scoped, not tied to a
single job application (unlike ResuDeps's siblings in agent/resu).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone


@dataclass
class LinkedinDeps:
    api_base_url: str
    user_id: str = "local"

    def user_today(self) -> date:
        return datetime.now(timezone.utc).date()
