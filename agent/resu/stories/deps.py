"""StoriesDeps — same ResuDeps shape, its own name since this is a distinct
agent (single structured-output extraction call, no multi-turn/session state).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class StoriesDeps:
    api_base_url: str
