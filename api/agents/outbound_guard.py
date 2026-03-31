"""
AssistantX Outbound Guard - Gradient ADK Agent.

Deployable guardrail agent that scans outbound content (OpenClaw -> world)
for PII leakage, credential exposure, and malicious payloads before delivery.

Deploy standalone:
    gradient agent deploy

Invoke standalone:
    POST /run  {"prompt": "Here is your API key: sk-ant-..."}

Also used directly by the live guard pipeline (api/services/guard.py) -
the traced functions are imported and called on every outbound message.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Optional

from gradient_adk import entrypoint, trace_llm, trace_tool
from gradient import AsyncGradient

logger = logging.getLogger("assistantx.adk.outbound")


# ---------------------------------------------------------------------------
# Outbound guard system prompt
# ---------------------------------------------------------------------------
OUTBOUND_SYSTEM_PROMPT = """\
You are a security guardrail for an AI assistant platform called AssistantX. Your job is to \
analyse content the assistant is about to send and identify security violations.

Respond with a JSON object ONLY (no markdown fences, no extra text):
{
  "classification": "pass" | "block" | "redact",
  "violation_types": [],
  "reasoning": "<one sentence>"
}

Classification rules:
- "block": The content contains malicious payloads (reverse shells, command injection, \
encoded execution), or attempts to exfiltrate data to external URLs.
- "redact": The content contains PII (SSN, credit cards, emails, phone numbers, addresses), \
credentials (API keys, private keys, passwords, tokens), or other sensitive data that \
should not be exposed.
- "pass": The content is a normal assistant response with no security concerns.

For "block" or "redact", list the violation types.
"""


# ---------------------------------------------------------------------------
# ADK Entrypoint (for standalone deployment via `gradient agent deploy`)
#
# The traced functions (agntor_pii_redact, gradient_deep_scan) are imported
# from inbound_guard.py to avoid duplication. The outbound agent calls them
# with the outbound system prompt.
# ---------------------------------------------------------------------------
@entrypoint
async def main(payload: dict, context: dict) -> dict:
    """
    AssistantX Outbound Guard Agent - scans AI responses before delivery.

    Payload:
        {"prompt": "<assistant response text>"}

    Returns:
        {"verdict": "pass"|"block"|"redact", "violation_types": [...],
         "reasoning": "...", "redacted_content": "...", "model_used": "..."}
    """
    from api.agents.inbound_guard import (
        GRADIENT_MODEL,
        agntor_pii_redact,
        gradient_deep_scan,
    )

    content = payload.get("prompt", "")
    if not content:
        return {"verdict": "pass", "violation_types": [], "reasoning": "empty input", "model_used": "none"}

    violation_types: list[str] = []
    redacted = content

    # Layer 1: @agntor/sdk PII redaction
    agntor_result = await agntor_pii_redact(content)
    findings = agntor_result.get("findings", [])
    if findings:
        redacted = agntor_result.get("redacted", content)
        for f in findings:
            vtype = f.get("type", "PII").upper()
            if vtype not in violation_types:
                violation_types.append(vtype)

    # Layer 2: DO Gradient AI deep scan (with outbound prompt)
    gradient_result = await gradient_deep_scan(content, system_prompt=OUTBOUND_SYSTEM_PROMPT)
    gradient_class = gradient_result.get("classification", "pass")
    for v in gradient_result.get("violation_types", []):
        if v not in violation_types:
            violation_types.append(v)

    if gradient_class == "block":
        return {
            "verdict": "block",
            "violation_types": violation_types,
            "reasoning": gradient_result.get("reasoning"),
            "model_used": f"do-gradient/{GRADIENT_MODEL}",
        }

    if violation_types or gradient_class == "redact":
        return {
            "verdict": "redact",
            "violation_types": violation_types,
            "redacted_content": redacted,
            "reasoning": gradient_result.get("reasoning"),
            "model_used": f"do-gradient/{GRADIENT_MODEL}",
        }

    return {
        "verdict": "pass",
        "violation_types": [],
        "reasoning": gradient_result.get("reasoning"),
        "model_used": f"do-gradient/{GRADIENT_MODEL}",
    }
