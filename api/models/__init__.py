"""Shared Pydantic models / domain types."""

from __future__ import annotations

from enum import Enum
from typing import Any, Optional
from datetime import datetime

from pydantic import BaseModel, Field


class InstanceStatus(str, Enum):
    CREATING = "creating"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"


class GuardVerdict(str, Enum):
    PASS = "pass"
    BLOCK = "block"
    REDACT = "redact"


class GuardDirection(str, Enum):
    INBOUND = "inbound"   # user → OpenClaw
    OUTBOUND = "outbound" # OpenClaw → world


class InstanceConfig(BaseModel):
    """Configuration submitted by the user to create a managed OpenClaw instance."""

    name: str = Field(..., description="Human-readable instance name")
    # Secrets — stored encrypted, injected at proxy level (never passed to OpenClaw raw)
    google_gemini_api_key: Optional[str] = Field(None, description="Google Gemini API key")
    anthropic_api_key: Optional[str] = Field(None, description="Anthropic API key")
    openai_api_key: Optional[str] = Field(None, description="OpenAI API key")
    telegram_bot_token: Optional[str] = Field(None, description="Telegram bot token")
    # Default model — OpenClaw model string
    model: str = Field("google/gemini-2.0-flash", description="LLM model for this instance")
    # Guardrail policy overrides
    block_pii: bool = True
    block_prompt_injection: bool = True
    block_malicious_commands: bool = True
    # Allowed tool IDs (defaults to safe subset)
    tool_allowlist: list[str] = Field(
        default_factory=lambda: ["read", "write", "edit", "bash_safe"],
        description="OpenClaw tool IDs allowed to execute",
    )
    tool_blocklist: list[str] = Field(
        default_factory=lambda: ["browser", "system.run"],
        description="OpenClaw tool IDs that are always blocked",
    )


class Instance(BaseModel):
    """A managed OpenClaw instance."""

    id: str
    name: str
    status: InstanceStatus
    container_id: Optional[str] = None
    gateway_port: Optional[int] = None    # host port for OpenClaw gateway WebSocket
    gateway_token: Optional[str] = None   # gateway auth token (from openclaw.json)
    gateway_device_id: Optional[str] = None       # device identity for gateway auth
    gateway_device_pubkey: Optional[str] = None   # PEM public key
    gateway_device_privkey: Optional[str] = None  # PEM private key
    proxy_port: int                        # exposed via AssistantX proxy
    created_at: datetime
    config: InstanceConfig


class AuditEvent(BaseModel):
    """A single guardrail decision recorded for audit."""

    id: str
    instance_id: str
    timestamp: datetime
    direction: GuardDirection
    verdict: GuardVerdict
    violation_types: list[str] = Field(default_factory=list)
    original_preview: str  # first 120 chars of original message
    redacted_preview: Optional[str] = None  # after redaction
    reasoning: Optional[str] = None
    model_used: Optional[str] = None


class GuardResult(BaseModel):
    verdict: GuardVerdict
    violation_types: list[str] = Field(default_factory=list)
    redacted_content: Optional[str] = None
    reasoning: Optional[str] = None
    model_used: Optional[str] = None
