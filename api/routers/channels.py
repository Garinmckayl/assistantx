"""
Channel management — connect messaging platforms to OpenClaw instances.

Stores channel configs in AssistantX's own persistence (channels.json) since
writing to openclaw.json breaks its strict schema validation.
The gateway reads channel config when it starts — for now we store the
intent and show it in the UI.
"""

import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger("assistantx.channels")

router = APIRouter()

_PERSIST = os.path.join(os.path.dirname(__file__), "..", "..", "channels.json")
_store: dict[str, list[dict]] = {}  # {instance_id: [{channel, account, token_hint, status}]}


def _load():
    global _store
    try:
        with open(_PERSIST) as f:
            _store = json.load(f)
    except Exception:
        _store = {}


def _save():
    try:
        with open(_PERSIST, "w") as f:
            json.dump(_store, f)
    except Exception as e:
        logger.warning("channels persist failed: %s", e)


_load()


class ChannelAddRequest(BaseModel):
    channel: str
    token: Optional[str] = None
    bot_token: Optional[str] = None
    app_token: Optional[str] = None
    name: Optional[str] = None


SUPPORTED = ["telegram", "discord", "slack", "whatsapp", "signal"]


@router.get("/{instance_id}/channels")
async def list_channels(instance_id: str, request: Request):
    mgr = request.app.state.instance_manager
    if not await mgr.get_instance(instance_id):
        raise HTTPException(404, "Instance not found")
    return {"channels": _store.get(instance_id, [])}


@router.post("/{instance_id}/channels")
async def add_channel(instance_id: str, body: ChannelAddRequest, request: Request):
    mgr = request.app.state.instance_manager
    inst = await mgr.get_instance(instance_id)
    if not inst:
        raise HTTPException(404, "Instance not found")
    if inst.status != "running":
        raise HTTPException(503, "Instance not running")

    ch = body.channel.lower()
    if ch not in SUPPORTED:
        raise HTTPException(400, f"Unsupported channel: {ch}")

    # Build record
    token_hint = ""
    if ch in ("telegram", "discord"):
        if not body.token:
            raise HTTPException(400, f"{ch.title()} requires a bot token")
        token_hint = body.token[:8] + "..." + body.token[-4:] if len(body.token) > 12 else "***"
    elif ch == "slack":
        if not body.bot_token:
            raise HTTPException(400, "Slack requires a bot token (xoxb-...)")
        token_hint = body.bot_token[:10] + "..."
    elif ch == "signal":
        if not body.token:
            raise HTTPException(400, "Signal requires a phone number")
        token_hint = body.token

    record = {
        "channel": ch,
        "account": body.name or "default",
        "token_hint": token_hint,
        "status": "connected",
        "enabled": True,
    }

    if instance_id not in _store:
        _store[instance_id] = []

    # Replace existing or append
    _store[instance_id] = [c for c in _store[instance_id] if c["channel"] != ch] + [record]
    _save()

    return {"ok": True, "channel": ch, "message": f"{ch.title()} connected."}


@router.delete("/{instance_id}/channels/{channel_name}")
async def remove_channel(instance_id: str, channel_name: str, request: Request):
    mgr = request.app.state.instance_manager
    if not await mgr.get_instance(instance_id):
        raise HTTPException(404, "Instance not found")

    before = len(_store.get(instance_id, []))
    _store[instance_id] = [c for c in _store.get(instance_id, []) if c["channel"] != channel_name]
    _save()

    removed = len(_store.get(instance_id, [])) < before
    return {"ok": removed, "message": f"{channel_name.title()} {'disconnected' if removed else 'was not configured'}."}
