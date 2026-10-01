"""FastAPI router for per-entry detailed document generation — mounted onto
the same app instance as agent/resu/service.py (see main.py). Called by
NestJS's StoriesService only when the user explicitly clicks "Generate" on
an entry — not implicitly during resume generation. Stateless, one-shot; the
document itself (not this endpoint) is what's cached/persisted, in
Postgres's EntryDocument table on the NestJS side.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .agent import generate_document

router = APIRouter(prefix="/stories", tags=["stories"])


class GenerateDocumentRequest(BaseModel):
    existing_document_html: str
    raw_sources: list[str]
    entry_label: str


class GenerateDocumentResponse(BaseModel):
    content_html: str


@router.post("/generate-document", response_model=GenerateDocumentResponse)
async def generate_document_endpoint(body: GenerateDocumentRequest) -> GenerateDocumentResponse:
    content_html = await generate_document(body.existing_document_html, body.raw_sources, body.entry_label)
    return GenerateDocumentResponse(content_html=content_html)
