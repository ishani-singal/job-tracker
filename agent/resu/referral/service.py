"""FastAPI router for referral requests — mounted onto the same app as
agent/resu/service.py. Called by NestJS's SessionsService (REFERRAL scope):
one long unattended call per "Generate referral" click; NestJS persists the
result, this side stays stateless."""
from __future__ import annotations

import os

from fastapi import APIRouter
from pydantic import BaseModel

from .agent import Channel, ReferralResult, RoleInput, Tone, run_referral

router = APIRouter(prefix="/referral", tags=["referral"])

API_BASE_URL = os.environ.get("JOB_TRACKER_API_URL", "http://localhost:4100")


class RunReferralRequest(BaseModel):
    session_id: str
    company: str
    contact_name: str
    tone: Tone
    channel: Channel
    roles: list[RoleInput]
    # Text of a resume the user uploaded in the chat — the base for a final draft.
    uploaded_resume: str | None = None


@router.post("/run", response_model=ReferralResult)
async def run_referral_endpoint(body: RunReferralRequest) -> ReferralResult:
    return await run_referral(
        body.session_id, API_BASE_URL, body.company, body.contact_name, body.tone, body.channel, body.roles, body.uploaded_resume
    )
