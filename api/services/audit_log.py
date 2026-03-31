"""
Audit logger — streams guardrail events to:
  1. In-memory ring buffer (for dashboard SSE stream)
  2. DO Spaces (S3-compatible) as NDJSON files

Each record is an AuditEvent Pydantic model serialised to JSON.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Deque, List

import boto3
import botocore.exceptions

from api.models import AuditEvent

logger = logging.getLogger("assistantx.audit")

# DO Spaces config (S3-compatible)
DO_SPACES_ENDPOINT = os.getenv("DO_SPACES_ENDPOINT", "https://nyc3.digitaloceanspaces.com")
DO_SPACES_KEY = os.getenv("DO_SPACES_KEY", "")
DO_SPACES_SECRET = os.getenv("DO_SPACES_SECRET", "")
DO_SPACES_BUCKET = os.getenv("DO_SPACES_BUCKET", "assistantx-audit")
DO_SPACES_REGION = os.getenv("DO_SPACES_REGION", "nyc3")

RING_BUFFER_SIZE = 500  # keep last N events in memory


class AuditLogger:
    def __init__(self):
        self._ring: Deque[AuditEvent] = deque(maxlen=RING_BUFFER_SIZE)
        self._subscribers: List[asyncio.Queue] = []
        self._s3 = None
        self._spaces_available = False
        self._init_spaces()

    def _init_spaces(self):
        if not DO_SPACES_KEY or not DO_SPACES_SECRET:
            logger.warning("DO Spaces credentials not set — audit log stored in memory only")
            return
        try:
            self._s3 = boto3.client(
                "s3",
                endpoint_url=DO_SPACES_ENDPOINT,
                aws_access_key_id=DO_SPACES_KEY,
                aws_secret_access_key=DO_SPACES_SECRET,
                region_name=DO_SPACES_REGION,
            )
            # Ensure bucket exists
            try:
                self._s3.head_bucket(Bucket=DO_SPACES_BUCKET)
            except botocore.exceptions.ClientError as e:
                if e.response["Error"]["Code"] == "404":
                    self._s3.create_bucket(Bucket=DO_SPACES_BUCKET)
                    logger.info("Created Spaces bucket: %s", DO_SPACES_BUCKET)
            self._spaces_available = True
            logger.info("DO Spaces audit sink ready: %s/%s", DO_SPACES_ENDPOINT, DO_SPACES_BUCKET)
        except Exception as exc:
            logger.warning("DO Spaces init failed (%s) — in-memory only", exc)

    async def log(self, event: AuditEvent):
        """Record an audit event."""
        self._ring.append(event)
        # Fan-out to SSE subscribers
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass
        # Async flush to Spaces
        if self._spaces_available:
            asyncio.create_task(self._flush_to_spaces(event))

    async def _flush_to_spaces(self, event: AuditEvent):
        loop = asyncio.get_event_loop()
        try:
            key = f"audit/{event.instance_id}/{event.timestamp.strftime('%Y/%m/%d')}/{event.id}.json"
            body = event.model_dump_json()
            await loop.run_in_executor(
                None,
                lambda: self._s3.put_object(
                    Bucket=DO_SPACES_BUCKET,
                    Key=key,
                    Body=body.encode(),
                    ContentType="application/json",
                ),
            )
        except Exception as exc:
            logger.warning("Spaces flush error: %s", exc)

    def recent(self, instance_id: str | None = None, limit: int = 100) -> list[AuditEvent]:
        events = list(self._ring)
        if instance_id:
            events = [e for e in events if e.instance_id == instance_id]
        return events[-limit:]

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass
