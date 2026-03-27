"""
SSE events router — streams audit events to the dashboard in real time.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger("assistantx.events")

router = APIRouter()


@router.get("/stream")
async def event_stream(request: Request, instance_id: str | None = None):
    """
    Server-Sent Events endpoint.
    The dashboard subscribes here to receive live guardrail audit events.
    """
    audit_logger = request.app.state.audit_logger
    queue = audit_logger.subscribe()

    async def generate():
        # Send recent events on connect
        for event in audit_logger.recent(instance_id=instance_id, limit=50):
            yield f"data: {event.model_dump_json()}\n\n"

        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=5.0)
                    if instance_id is None or event.instance_id == instance_id:
                        yield f"data: {event.model_dump_json()}\n\n"
                except asyncio.TimeoutError:
                    # Heartbeat to keep connection alive
                    yield ": heartbeat\n\n"
        finally:
            audit_logger.unsubscribe(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/recent")
async def recent_events(request: Request, instance_id: str | None = None, limit: int = 100):
    """Return recent audit events as JSON."""
    audit_logger = request.app.state.audit_logger
    events = audit_logger.recent(instance_id=instance_id, limit=limit)
    return [e.model_dump() for e in events]
