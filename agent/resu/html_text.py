"""Strips an EntryDocument's small, fixed HTML tag vocabulary down to plain
text — shared by agent.py's eager document prefetch and tools.py's
model-callable document-fetch tool, both of which feed a document into the
resume/LinkedIn generation prompt as plain prose, not markup. A regex strip
is enough given the constrained, LLM-controlled tag set (see
stories/definition.py's ALLOWED_TAGS), not a full HTML parser — same
lightweight-regex spirit as this repo's extract-text.ts.
"""
from __future__ import annotations

import re

_HTML_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(html: str) -> str:
    text = _HTML_TAG_RE.sub("\n", html)
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)
