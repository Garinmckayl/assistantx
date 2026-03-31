"""
Dead-Man Switch router.

POST /api/deadman/{instance_id}/checkin     — send a check-in pulse
GET  /api/deadman/{instance_id}/status      — get current switch state
POST /api/deadman/{instance_id}/setup       — configure the switch
POST /api/deadman/{instance_id}/rearm       — re-arm after trigger (trusted contact only)
POST /api/deadman/{instance_id}/simulate    — simulate a missed check-in (demo)
GET  /api/deadman/{instance_id}/vault       — list active vault tokens (consent view)
"""

from __future__ import annotations

import logging
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from api.services.deadman import (
    DeadManSwitch,
    SecureDestination,
    SwitchConfig,
    SwitchState,
    TrustedContact,
    create_switch,
    delete_switch,
    get_switch,
)
from api.services.token_vault import get_vault

logger = logging.getLogger("assistantx.routers.deadman")

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CheckinRequest(BaseModel):
    word: str = "alive"


class CheckinResponse(BaseModel):
    accepted: bool
    state: str
    next_checkin_due: Optional[float]
    message: str


class TrustedContactIn(BaseModel):
    name: str
    email: str
    notify_on_grace: bool = True
    notify_on_trigger: bool = True
    can_rearm: bool = True


class SecureDestinationIn(BaseModel):
    name: str
    type: str   # github | s3 | proton | securedrop
    url: str


class SetupRequest(BaseModel):
    checkin_interval_hours: float = 24.0
    grace_period_hours: float = 2.0
    checkin_word: str = "alive"
    trusted_contacts: List[TrustedContactIn] = []
    secure_destinations: List[SecureDestinationIn] = []
    encrypt_paths: List[str] = []


class RearmRequest(BaseModel):
    trusted_contact_email: str


class SimulateRequest(BaseModel):
    scenario: str = "missed_checkin"  # missed_checkin | grace_expired | trigger


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/{instance_id}/setup")
async def setup_switch(instance_id: str, body: SetupRequest, request: Request):
    """
    Configure the Dead-Man Switch for an instance.
    Creates the switch if it doesn't exist, reconfigures if it does.
    """
    # Validate instance exists
    mgr = request.app.state.instance_manager
    instance = await mgr.get_instance(instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    # Delete existing switch if present
    existing = get_switch(instance_id)
    if existing:
        delete_switch(instance_id)

    config = SwitchConfig(
        instance_id=instance_id,
        checkin_interval_seconds=int(body.checkin_interval_hours * 3600),
        grace_period_seconds=int(body.grace_period_hours * 3600),
        checkin_word=body.checkin_word,
        trusted_contacts=[
            TrustedContact(
                name=c.name,
                email=c.email,
                notify_on_grace=c.notify_on_grace,
                notify_on_trigger=c.notify_on_trigger,
                can_rearm=c.can_rearm,
            )
            for c in body.trusted_contacts
        ],
        secure_destinations=[
            SecureDestination(name=d.name, type=d.type, url=d.url)
            for d in body.secure_destinations
        ],
        encrypt_paths=body.encrypt_paths,
    )

    switch = create_switch(config)

    return {
        "status": "configured",
        "state": switch.status.state.value,
        "checkin_interval_hours": body.checkin_interval_hours,
        "grace_period_hours": body.grace_period_hours,
        "checkin_word": "***",  # never echo the word back
        "trusted_contacts": len(config.trusted_contacts),
        "secure_destinations": len(config.secure_destinations),
        "next_checkin_due": switch.status.next_checkin_due,
        "message": (
            "Dead-Man Switch armed. Send a check-in before the deadline. "
            "If you miss it, the protocol activates automatically."
        ),
    }


@router.post("/{instance_id}/checkin", response_model=CheckinResponse)
async def checkin(instance_id: str, body: CheckinRequest):
    """
    Send a check-in pulse to keep the switch armed.
    Must include the correct check-in word.
    """
    switch = get_switch(instance_id)
    if not switch:
        raise HTTPException(
            status_code=404,
            detail="No Dead-Man Switch configured for this instance. Call /setup first.",
        )

    accepted = switch.checkin(body.word)

    if accepted:
        return CheckinResponse(
            accepted=True,
            state=switch.status.state.value,
            next_checkin_due=switch.status.next_checkin_due,
            message=(
                f"Check-in accepted. Next check-in due in "
                f"{switch.config.checkin_interval_seconds // 3600:.0f} hour(s). "
                f"Total check-ins: {switch.status.checkins_total}."
            ),
        )
    else:
        state = switch.status.state.value
        if state in (SwitchState.TRIGGERED, SwitchState.COMPLETED):
            msg = "Protocol has already been activated. Contact a trusted person to re-arm."
        else:
            msg = "Check-in rejected. Wrong word."

        return CheckinResponse(
            accepted=False,
            state=state,
            next_checkin_due=switch.status.next_checkin_due,
            message=msg,
        )


@router.get("/{instance_id}/status")
async def get_status(instance_id: str):
    """Get the current Dead-Man Switch state and timing."""
    switch = get_switch(instance_id)
    if not switch:
        return {
            "configured": False,
            "message": "No Dead-Man Switch configured for this instance.",
        }

    status = switch.get_status()
    status["configured"] = True
    return status


@router.post("/{instance_id}/rearm")
async def rearm(instance_id: str, body: RearmRequest):
    """
    Re-arm the switch after it has been triggered.
    Requires authorization from a trusted contact.
    This is the step-up authentication gate.
    """
    switch = get_switch(instance_id)
    if not switch:
        raise HTTPException(status_code=404, detail="No switch configured.")

    if switch.status.state not in (SwitchState.TRIGGERED, SwitchState.COMPLETED, SwitchState.GRACE):
        raise HTTPException(
            status_code=400,
            detail=f"Switch is in state '{switch.status.state.value}' — re-arm not needed.",
        )

    success = await switch.rearm(body.trusted_contact_email)
    if not success:
        raise HTTPException(
            status_code=403,
            detail="Re-arm denied. The provided email is not an authorized trusted contact.",
        )

    return {
        "rearmed": True,
        "rearmed_by": body.trusted_contact_email,
        "state": switch.status.state.value,
        "next_checkin_due": switch.status.next_checkin_due,
        "message": "Switch re-armed. Remember to check in before the deadline.",
    }


@router.post("/{instance_id}/simulate")
async def simulate(instance_id: str, body: SimulateRequest):
    """
    Simulate Dead-Man Switch scenarios for demo purposes.
    Only available when ASSISTANTX_DEMO_MODE=true.
    """
    import os
    if os.getenv("ASSISTANTX_DEMO_MODE", "false").lower() != "true":
        raise HTTPException(status_code=403, detail="Simulation only available in demo mode.")

    switch = get_switch(instance_id)
    if not switch:
        raise HTTPException(status_code=404, detail="No switch configured.")

    if body.scenario == "missed_checkin":
        # Force the switch into grace period
        switch.status.next_checkin_due = time.time() - 1
        await switch._tick()
        return {"simulated": "missed_checkin", "state": switch.status.state.value}

    elif body.scenario == "grace_expired":
        # Force grace period to expire
        switch.status.state = SwitchState.GRACE
        switch.status.grace_expires_at = time.time() - 1
        switch.status.next_checkin_due = time.time() - 3601
        await switch._tick()
        return {"simulated": "grace_expired", "state": switch.status.state.value}

    elif body.scenario == "trigger":
        # Directly trigger the protocol
        import asyncio
        switch.status.state = SwitchState.TRIGGERED
        switch.status.trigger_time = time.time()
        asyncio.create_task(switch._execute_protocol())
        return {"simulated": "trigger", "state": switch.status.state.value,
                "message": "Protocol executing — check /status for distribution log."}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown scenario: {body.scenario}")


@router.get("/{instance_id}/vault")
async def vault_tokens(instance_id: str):
    """
    List active Token Vault connections for this instance.
    This is the user consent view — shows exactly what the agent is authorized to do.
    No raw credentials are ever returned.
    """
    vault = get_vault()
    connections = vault.list_connections(instance_id)
    switch = get_switch(instance_id)

    return {
        "instance_id": instance_id,
        "switch_state": switch.status.state.value if switch else "not_configured",
        "active_connections": connections,
        "total_active": len(connections),
        "token_vault_mode": "auth0" if not vault.demo_mode else "demo",
        "message": (
            "These are the external connections currently authorized for your agent. "
            "Tokens are fetched from Auth0 Token Vault per-request — never stored on this machine. "
            "You stay in control."
        ),
    }
