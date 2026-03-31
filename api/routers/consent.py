"""
Consent router — OAuth flow and scope authorization.

GET  /api/consent/{instance_id}             — show what the agent is authorized to do
POST /api/consent/{instance_id}/authorize   — authorize a new service via OAuth
DELETE /api/consent/{instance_id}/revoke    — revoke a specific scope
POST /api/consent/{instance_id}/revoke-all  — revoke everything (nuclear option)
GET  /api/consent/{instance_id}/anomalies   — vault behavioral anomaly detector status

This is the user-facing control panel for Token Vault.
Users see exactly what their agent can access — and can revoke any scope at any time.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.services.token_vault import ConnectionScope, get_vault
from api.services.anomaly import get_detector

logger = logging.getLogger("assistantx.routers.consent")

router = APIRouter()

# Auth0 OAuth configuration
AUTH0_DOMAIN    = os.getenv("AUTH0_DOMAIN", "")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "")
AUTH0_REDIRECT  = os.getenv("AUTH0_REDIRECT_URI", "http://localhost:8000/api/consent/callback")

# Service → connection + scopes mapping
_SERVICE_MAP = {
    "github":    ("github",       ["repo:read", "repo"]),
    "gmail":     ("google-oauth2", [ConnectionScope.GMAIL_SCOPES[0]]),
    "drive":     ("google-oauth2", [ConnectionScope.GOOGLE_DRIVE_SCOPES[0]]),
    "google":    ("google-oauth2", [ConnectionScope.GOOGLE_DRIVE_SCOPES[0]]),
    "slack":     ("slack",         ["channels:read", "chat:write"]),
    "notion":    ("notion",        ["read_content", "update_content"]),
    "proton":    ("proton",        ["drive.write"]),
    "anthropic": ("anthropic",     ["inference"]),
    "openai":    ("openai",        ["inference"]),
    "gemini":    ("google-oauth2", ["inference"]),
}


class AuthorizeRequest(BaseModel):
    service: str        # "github", "notion", "gmail", "google", "drive", etc.
    scopes: list[str] = []
    ttl_hours: float = 24.0


class RevokeRequest(BaseModel):
    scope: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/{instance_id}")
async def get_consent_view(instance_id: str):
    """
    Return the full consent view for this instance.
    Shows every active connection, its scopes, and expiry.
    No raw tokens ever returned.
    """
    vault = get_vault()
    connections = vault.list_connections(instance_id)
    detector = get_detector(instance_id)

    return {
        "instance_id": instance_id,
        "active_connections": connections,
        "total": len(connections),
        "auth0_domain": AUTH0_DOMAIN or "not configured",
        "token_vault_mode": "auth0" if AUTH0_DOMAIN else "demo",
        "anomaly_detector": detector.summary(),
        "user_message": (
            "Your agent is authorized to act within these connections only. "
            "Raw credentials are never stored on this machine or in the container. "
            "Tokens are fetched from Auth0 Token Vault per-request and expire automatically. "
            "You can revoke access at any time."
        ),
    }


@router.get("/{instance_id}/anomalies")
async def get_anomaly_status(instance_id: str):
    """
    Return the vault behavioral anomaly detector status and recent findings.
    The isolation forest learns normal token access patterns and flags deviations.
    """
    detector = get_detector(instance_id)
    summary = detector.summary()

    # Surface recent anomalous events from history
    recent_anomalies = []
    if detector._history:
        history = list(detector._history)
        for i, event in enumerate(history[-20:], start=max(0, len(history) - 20)):
            if detector._model is not None and i >= 5:
                features = event.features(history[:i])
                result = detector._score(event, features)
                if result.anomalous:
                    recent_anomalies.append({
                        "connection": event.connection,
                        "scopes": event.scopes,
                        "score": round(result.score, 4),
                        "reason": result.reason,
                        "trigger": event.trigger,
                        "timestamp": event.timestamp,
                    })

    return {
        "instance_id": instance_id,
        **summary,
        "recent_anomalies": recent_anomalies[-10:],
        "description": (
            "Isolation Forest trained on vault token access patterns. "
            "Flags unusual connection requests, off-hours scope escalation, "
            "and abnormal request rates. Anomalies are logged at CRITICAL level."
        ),
    }


@router.post("/{instance_id}/authorize")
async def authorize_service(instance_id: str, body: AuthorizeRequest):
    """
    Authorize a new service for this instance via Auth0 OAuth.

    In production: redirects to Auth0 Token Vault OAuth flow.
    In demo mode: issues a local scoped token.
    """
    vault = get_vault()

    service = body.service.lower()
    if service not in _SERVICE_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown service '{body.service}'. Supported: {list(_SERVICE_MAP.keys())}",
        )

    connection, default_scopes = _SERVICE_MAP[service]
    scopes = body.scopes if body.scopes else default_scopes

    if AUTH0_DOMAIN and not vault.demo_mode:
        # Production: return Auth0 Connected Accounts authorization URL
        auth_url = (
            f"https://{AUTH0_DOMAIN}/authorize"
            f"?response_type=code"
            f"&client_id={AUTH0_CLIENT_ID}"
            f"&redirect_uri={AUTH0_REDIRECT}"
            f"&scope={' '.join(scopes)}"
            f"&connection={connection}"
        )
        return {
            "action": "redirect",
            "auth_url": auth_url,
            "message": (
                "Redirect user to auth_url to complete the "
                "Auth0 Connected Accounts OAuth flow."
            ),
        }

    # Demo mode: issue a local demo token
    vault._demo_token(instance_id, connection, scopes, ttl=int(body.ttl_hours * 3600))
    return {
        "action": "issued",
        "service": body.service,
        "connection": connection,
        "scopes": scopes,
        "expires_in_seconds": int(body.ttl_hours * 3600),
        "mode": "demo",
        "message": (
            f"Demo token issued for {body.service} ({connection}). "
            f"In production this triggers an Auth0 Connected Accounts OAuth flow. "
            f"Raw credential never leaves the vault."
        ),
    }


@router.delete("/{instance_id}/revoke")
async def revoke_scope(instance_id: str, body: RevokeRequest):
    """Revoke a specific connection's cached token."""
    vault = get_vault()
    cache = vault._cache.get(instance_id, {})

    if body.scope not in cache:
        raise HTTPException(
            status_code=404,
            detail=f"No active token found for connection '{body.scope}'.",
        )

    del cache[body.scope]
    logger.info("Revoked connection=%s for instance=%s", body.scope, instance_id)

    return {
        "revoked": True,
        "connection": body.scope,
        "message": f"Token for '{body.scope}' has been revoked.",
    }


@router.post("/{instance_id}/revoke-all")
async def revoke_all(instance_id: str):
    """Revoke all tokens and credentials for this instance."""
    vault = get_vault()
    count = vault.revoke_all(instance_id)

    logger.warning("User revoked ALL tokens for instance=%s (%d)", instance_id, count)

    return {
        "revoked": count,
        "message": (
            f"All {count} token(s) and credential(s) revoked. "
            "Your agent has no authorization until you re-configure."
        ),
    }


from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.services.token_vault import TokenVaultClient, ConnectionScope, get_vault

logger = logging.getLogger("assistantx.routers.consent")

router = APIRouter()

# Auth0 OAuth configuration
AUTH0_DOMAIN    = os.getenv("AUTH0_DOMAIN", "")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "")
AUTH0_REDIRECT  = os.getenv("AUTH0_REDIRECT_URI", "http://localhost:8000/api/consent/callback")


class AuthorizeRequest(BaseModel):
    service: str        # "github", "notion", "gmail", "proton"
    scopes: list[str]   # requested scopes
    ttl_hours: float = 24.0


class RevokeRequest(BaseModel):
    scope: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/{instance_id}")
async def get_consent_view(instance_id: str):
    """
    Return the full consent view for this instance.
    Shows every active connection, its scopes, and expiry.
    No raw tokens ever returned.
    """
    vault = get_vault()
    connections = vault.list_connections(instance_id)

    return {
        "instance_id": instance_id,
        "active_connections": connections,
        "total": len(connections),
        "auth0_domain": AUTH0_DOMAIN or "not configured",
        "token_vault_mode": "auth0" if AUTH0_DOMAIN else "demo",
        "user_message": (
            "Your agent is authorized to act within these connections only. "
            "Raw credentials are never stored on this machine or in the container. "
            "Tokens are fetched from Auth0 Token Vault per-request and expire automatically. "
            "You can revoke access at any time."
        ),
    }


@router.post("/{instance_id}/authorize")
async def authorize_service(instance_id: str, body: AuthorizeRequest):
    """
    Authorize a new service for this instance via Auth0 OAuth.

    In production: redirects to Auth0 Token Vault OAuth flow.
    In demo mode: issues a local scoped token.
    """
    vault = get_vault()

    # Map service + scopes to TokenScope
    scope_map = {
        "github":  TokenScope.ENCRYPT_AND_DISTRIBUTE,
        "notion":  TokenScope.AGENT_WRITE,
        "gmail":   TokenScope.NOTIFY_CONTACTS,
        "proton":  TokenScope.ENCRYPT_AND_DISTRIBUTE,
        "anthropic": TokenScope.OPENCLAW_ANTHROPIC,
        "openai":  TokenScope.OPENCLAW_OPENAI,
        "gemini":  TokenScope.OPENCLAW_GEMINI,
    }

    token_scope = scope_map.get(body.service.lower())
    if not token_scope:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown service '{body.service}'. Supported: {list(scope_map.keys())}",
        )

    if AUTH0_DOMAIN and not vault.demo_mode:
        # Production: return Auth0 Connected Accounts authorization URL
        auth_url = (
            f"https://{AUTH0_DOMAIN}/authorize"
            f"?response_type=code"
            f"&client_id={AUTH0_CLIENT_ID}"
            f"&redirect_uri={AUTH0_REDIRECT}"
            f"&scope={' '.join(body.scopes)}"
            f"&connection={body.service}"
        )
        return {
            "action": "redirect",
            "auth_url": auth_url,
            "message": (
                "Redirect user to auth_url to complete the "
                "Auth0 Connected Accounts OAuth flow."
            ),
        }

    # Demo mode: issue a local demo token
    token = vault._demo_token(instance_id, body.service, body.scopes,
                               ttl=int(body.ttl_hours * 3600))
    return {
        "action": "issued",
        "service": body.service,
        "scopes": body.scopes,
        "expires_in_seconds": int(body.ttl_hours * 3600),
        "mode": "demo",
        "message": (
            f"Demo token issued for {body.service}. "
            f"In production this triggers an Auth0 Connected Accounts OAuth flow. "
            f"Raw credential never leaves the vault."
        ),
    }


@router.delete("/{instance_id}/revoke")
async def revoke_scope(instance_id: str, body: RevokeRequest):
    """Revoke a specific connection's cached token."""
    vault = get_vault()
    cache = vault._cache.get(instance_id, {})

    if body.scope not in cache:
        raise HTTPException(
            status_code=404,
            detail=f"No active token found for connection '{body.scope}'.",
        )

    del cache[body.scope]
    logger.info("Revoked connection=%s for instance=%s", body.scope, instance_id)

    return {
        "revoked": True,
        "connection": body.scope,
        "message": f"Token for '{body.scope}' has been revoked.",
    }


@router.post("/{instance_id}/revoke-all")
async def revoke_all(instance_id: str):
    """Revoke all tokens and credentials for this instance."""
    vault = get_vault()
    count = vault.revoke_all(instance_id)

    logger.warning("User revoked ALL tokens for instance=%s (%d)", instance_id, count)

    return {
        "revoked": count,
        "message": (
            f"All {count} token(s) and credential(s) revoked. "
            "Your agent has no authorization until you re-configure."
        ),
    }
