"""ResuDeps — local stand-in for Soma's SomaDeps.

Shaped close to what a SomaDeps-compatible protocol would need (user_id, a db
handle, user_today()) per the new-agent skill's cross-repo guidance, so swapping
this for the real SomaDeps at Soma-merge time is a type substitution, not a rewrite.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone


@dataclass
class ResuDeps:
    api_base_url: str
    user_id: str = "local"

    def user_today(self) -> date:
        return datetime.now(timezone.utc).date()
