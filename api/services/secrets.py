"""
Secret vault — stores and injects user secrets at the proxy layer.

Secrets are kept in memory (or optionally in DO Managed Database/KV).
They are NEVER stored inside the OpenClaw container config.
Instead, the proxy substitutes placeholder tokens before forwarding requests.
"""

from __future__ import annotations

import logging
import os
from typing import Dict, Optional

logger = logging.getLogger("assistantx.secrets")

# In a real deployment this would be backed by DO Managed Secrets / KV store.
# For the demo we keep an in-memory dict keyed by instance_id.
_vault: Dict[str, Dict[str, str]] = {}

# Placeholder tokens written into the OpenClaw config
# The proxy rewrites these to real values in the HTTP headers / WS frames.
PLACEHOLDER_ANTHROPIC = "__ASSISTANTX_ANTHROPIC_KEY__"
PLACEHOLDER_OPENAI = "__ASSISTANTX_OPENAI_KEY__"
PLACEHOLDER_TELEGRAM = "__ASSISTANTX_TELEGRAM_TOKEN__"


def store_secrets(instance_id: str, config) -> None:
    """
    Extract secrets from the instance config and store them in the vault.
    Returns a sanitised config where secrets are replaced with placeholders.
    """
    secrets: Dict[str, str] = {}
    if config.google_gemini_api_key:
        secrets["google_gemini_api_key"] = config.google_gemini_api_key
    if config.anthropic_api_key:
        secrets["anthropic_api_key"] = config.anthropic_api_key
    if config.openai_api_key:
        secrets["openai_api_key"] = config.openai_api_key
    if config.telegram_bot_token:
        secrets["telegram_bot_token"] = config.telegram_bot_token
    if hasattr(config, "model") and config.model:
        secrets["model"] = config.model
    _vault[instance_id] = secrets
    logger.info("Stored %d secret(s) for instance %s", len(secrets), instance_id)


def get_secrets(instance_id: str) -> Dict[str, str]:
    return _vault.get(instance_id, {})


def inject_into_headers(instance_id: str, headers: dict) -> dict:
    """
    Inject secrets into outbound HTTP headers before forwarding to OpenClaw.
    OpenClaw reads ANTHROPIC_API_KEY / OPENAI_API_KEY from the environment,
    but we can also pass them via X-Ombre-* headers for dynamic override.
    """
    s = get_secrets(instance_id)
    new_headers = dict(headers)
    if "anthropic_api_key" in s:
        new_headers["X-Anthropic-Api-Key"] = s["anthropic_api_key"]
    if "openai_api_key" in s:
        new_headers["X-OpenAI-Api-Key"] = s["openai_api_key"]
    return new_headers


def delete_secrets(instance_id: str) -> None:
    _vault.pop(instance_id, None)
    logger.info("Deleted secrets for instance %s", instance_id)
