"""
DO Gradient AI guardrail - live request pipeline.

This module is the entry point called on every inbound/outbound message.
It delegates to the ADK agent traced functions in api/agents/ so that
every live request flows through @trace_llm and @trace_tool decorated code.

Guard pipeline layers:
  1. @agntor/sdk semantic scan (via ADK @trace_tool) (~5ms)
  2. DO Gradient llama3.3-70b-instruct deep classification (via ADK @trace_llm) (~200ms)

Supports two DO Gradient inference modes:
  - Serverless Inference (default): pay-per-token, zero infrastructure
  - Dedicated Inference (GPU): for high-throughput production deployments on
    dedicated AMD MI300X or NVIDIA GPUs via DO Gradient Dedicated Inference.
    Set DO_GRADIENT_DEDICATED_ENDPOINT to enable.
"""

from __future__ import annotations

import logging

from api.agents.inbound_guard import (
    GRADIENT_MODEL,
    INBOUND_SYSTEM_PROMPT,
    agntor_pii_redact,
    agntor_semantic_scan,
    gradient_deep_scan,
)
from api.agents.outbound_guard import OUTBOUND_SYSTEM_PROMPT
from api.models import GuardDirection, GuardResult, GuardVerdict

logger = logging.getLogger("assistantx.guard")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def guard_inbound(content: str) -> GuardResult:
    """
    Guard an inbound message (user -> OpenClaw).

    Layers (all via ADK traced functions):
      1. @agntor/sdk guard() + redact() - @trace_tool("agntor_semantic_scan") (~5ms)
      2. DO Gradient AI deep scan - @trace_llm("gradient_deep_scan") (~200ms)
    """

    # -- Layer 1: @agntor/sdk guard (traced via ADK @trace_tool) -----------
    agntor_result = await agntor_semantic_scan(content)
    if agntor_result.get("classification") == "block":
        return GuardResult(
            verdict=GuardVerdict.BLOCK,
            violation_types=agntor_result.get("violation_types", ["PROMPT_INJECTION"]),
            reasoning=agntor_result.get("reasoning", "agntor/sdk guard flagged"),
            model_used="@agntor/sdk",
        )

    # Layer 1b: @agntor/sdk redact - check for PII in user input
    agntor_redact_result = await agntor_pii_redact(content)
    findings = agntor_redact_result.get("findings", [])
    if findings:
        redacted_text = agntor_redact_result.get("redacted", content)
        pii_types = [f.get("type", "PII").upper() for f in findings]
        return GuardResult(
            verdict=GuardVerdict.REDACT,
            violation_types=pii_types,
            redacted_content=redacted_text,
            reasoning=f"PII detected by @agntor/sdk: {', '.join(pii_types)}",
            model_used="@agntor/sdk",
        )

    # -- Layer 2: DO Gradient AI deep scan (traced via ADK @trace_llm) -----
    gradient = await gradient_deep_scan(content, system_prompt=INBOUND_SYSTEM_PROMPT)
    classification = gradient.get("classification", "pass")

    if classification == "block":
        return GuardResult(
            verdict=GuardVerdict.BLOCK,
            violation_types=gradient.get("violation_types", ["PROMPT_INJECTION"]),
            reasoning=gradient.get("reasoning"),
            model_used=f"do-gradient/{GRADIENT_MODEL}",
        )

    if classification == "redact":
        # Gradient detected PII - use agntor to do the actual redaction
        redact_pass = await agntor_pii_redact(content)
        redacted_text = redact_pass.get("redacted", content)
        return GuardResult(
            verdict=GuardVerdict.REDACT,
            violation_types=gradient.get("violation_types", ["PII"]),
            redacted_content=redacted_text,
            reasoning=gradient.get("reasoning"),
            model_used=f"do-gradient/{GRADIENT_MODEL}",
        )

    return GuardResult(
        verdict=GuardVerdict.PASS,
        reasoning=gradient.get("reasoning"),
        model_used=f"do-gradient/{GRADIENT_MODEL}",
    )


async def guard_outbound(content: str) -> GuardResult:
    """
    Guard outbound content (OpenClaw -> world).

    Layers (all via ADK traced functions):
      1. @agntor/sdk redact() - @trace_tool("agntor_pii_redact") (~5ms)
      2. DO Gradient AI deep scan - @trace_llm("gradient_deep_scan") (~200ms)
    """
    violation_types: list[str] = []
    redacted = content

    # -- Layer 1: @agntor/sdk redact (traced via ADK @trace_tool) ----------
    agntor_redact = await agntor_pii_redact(content)
    findings = agntor_redact.get("findings", [])
    if findings:
        redacted = agntor_redact.get("redacted", redacted)
        for f in findings:
            vtype = f.get("type", "PII").upper()
            if vtype not in violation_types:
                violation_types.append(vtype)

    # -- Layer 2: DO Gradient AI deep scan (traced via ADK @trace_llm) -----
    gradient = await gradient_deep_scan(content, system_prompt=OUTBOUND_SYSTEM_PROMPT)
    gradient_class = gradient.get("classification", "pass")
    gradient_violations = gradient.get("violation_types", [])

    for v in gradient_violations:
        if v not in violation_types:
            violation_types.append(v)

    if gradient_class == "block":
        return GuardResult(
            verdict=GuardVerdict.BLOCK,
            violation_types=violation_types,
            reasoning=gradient.get("reasoning"),
            model_used=f"do-gradient/{GRADIENT_MODEL}",
        )

    if violation_types or gradient_class == "redact":
        return GuardResult(
            verdict=GuardVerdict.REDACT,
            violation_types=violation_types,
            redacted_content=redacted,
            reasoning=gradient.get("reasoning"),
            model_used=f"do-gradient/{GRADIENT_MODEL}",
        )

    return GuardResult(
        verdict=GuardVerdict.PASS,
        reasoning=gradient.get("reasoning"),
        model_used=f"do-gradient/{GRADIENT_MODEL}",
    )
