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
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
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
    "github":    ("github",        ["repo:read", "repo"]),
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
    service: str
    scopes: list[str] = []
    ttl_hours: float = 24.0


class RevokeRequest(BaseModel):
    scope: str


class SimpleRevokeRequest(BaseModel):
    service: str


# Default instance used by the single-instance frontend
DEFAULT_INSTANCE = "assistantx-default"


# ---------------------------------------------------------------------------
# Frontend-facing routes (no instance_id — use default instance)
# ---------------------------------------------------------------------------

@router.get("/connections")
async def list_connections():
    """
    Return all connected services for the default instance.
    Response: { connections: [{ service_id, status, scopes, connection }] }
    """
    vault = get_vault()
    raw = vault.list_connections(DEFAULT_INSTANCE)

    # Build a service_id → connection mapping for connected services
    connected_connections = {}
    for conn in raw:
        # Map connection names back to service ids
        for svc_id, (conn_name, _) in _SERVICE_MAP.items():
            if conn.get("connection") == conn_name or conn.get("scope", "").startswith(conn_name):
                connected_connections[svc_id] = conn

    connections = []
    for svc_id in _SERVICE_MAP:
        if svc_id in connected_connections:
            connections.append({
                "service_id": svc_id,
                "status": "connected",
                "scopes": connected_connections[svc_id].get("scopes", []),
            })
        else:
            connections.append({
                "service_id": svc_id,
                "status": "disconnected",
            })

    return {"connections": connections}


@router.post("/authorize")
async def authorize_service_simple(body: AuthorizeRequest):
    """
    Authorize a new service for the default instance.
    Simplified endpoint for the single-instance frontend.
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
        params = {
            "response_type": "code",
            "client_id": AUTH0_CLIENT_ID,
            "redirect_uri": AUTH0_REDIRECT,
            "scope": "openid profile email offline_access " + " ".join(scopes),
            "connection": connection,
            "access_type": "offline",
            "prompt": "consent",
            "state": service,  # pass service name through state for callback
        }
        auth_url = f"https://{AUTH0_DOMAIN}/authorize?{urlencode(params)}"
        return {
            "authorization_url": auth_url,
            "message": "Redirect user to authorization_url to complete Auth0 OAuth flow.",
        }

    # Demo mode — issue a local scoped token
    vault._demo_token(DEFAULT_INSTANCE, connection, scopes, ttl=int(body.ttl_hours * 3600))
    logger.info("Demo-authorized service=%s connection=%s for default instance", service, connection)
    return {
        "service": body.service,
        "connection": connection,
        "scopes": scopes,
        "mode": "demo",
        "message": f"Connected {body.service} (demo mode). In production this triggers Auth0 OAuth.",
    }


@router.post("/revoke")
async def revoke_service_simple(body: SimpleRevokeRequest):
    """
    Revoke a connected service for the default instance.
    Simplified endpoint — takes a service name instead of a raw connection scope.
    """
    vault = get_vault()
    service = body.service.lower()

    if service not in _SERVICE_MAP:
        raise HTTPException(status_code=400, detail=f"Unknown service '{body.service}'.")

    connection, _ = _SERVICE_MAP[service]
    cache = vault._cache.get(DEFAULT_INSTANCE, {})

    if connection in cache:
        del cache[connection]
        logger.info("Revoked service=%s connection=%s for default instance", service, connection)
        return {"revoked": True, "service": body.service}

    # Also check by service_id in case stored differently
    if service in cache:
        del cache[service]
        logger.info("Revoked service=%s for default instance", service)
        return {"revoked": True, "service": body.service}

    # Not found — still return success (idempotent)
    return {"revoked": True, "service": body.service, "note": "No active token found (already revoked)."}


@router.get("/callback")
async def oauth_callback(request: Request):
    """
    Auth0 OAuth callback — handles the redirect after user authorizes a connection.
    Exchanges the authorization code for tokens and stores them in the vault.
    Renders a self-closing HTML page that notifies the parent dashboard window.
    """
    code = request.query_params.get("code")
    error = request.query_params.get("error")
    error_description = request.query_params.get("error_description", "")
    state = request.query_params.get("state", "")

    if error:
        logger.error("OAuth callback error: %s — %s", error, error_description)
        return HTMLResponse(content=f"""
        <html><body>
        <h2>Authorization Failed</h2>
        <p>{error_description or error}</p>
        <script>
            if (window.opener) {{
                window.opener.postMessage({{ type: 'auth0-callback', error: '{error}' }}, '*');
                window.close();
            }}
        </script>
        </body></html>
        """, status_code=200)

    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    if not AUTH0_DOMAIN or not AUTH0_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Auth0 not configured on server")

    # Exchange authorization code for tokens
    client_secret = os.getenv("AUTH0_CLIENT_SECRET", "")
    token_url = f"https://{AUTH0_DOMAIN}/oauth/token"

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(token_url, json={
                "grant_type": "authorization_code",
                "client_id": AUTH0_CLIENT_ID,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": AUTH0_REDIRECT,
            })
            resp.raise_for_status()
            token_data = resp.json()
    except httpx.HTTPStatusError as exc:
        logger.error("Token exchange failed: %s %s", exc.response.status_code, exc.response.text)
        return HTMLResponse(content=f"""
        <html><body>
        <h2>Token Exchange Failed</h2>
        <p>Could not exchange authorization code. Please try again.</p>
        <script>
            if (window.opener) {{
                window.opener.postMessage({{ type: 'auth0-callback', error: 'token_exchange_failed' }}, '*');
                window.close();
            }}
        </script>
        </body></html>
        """, status_code=200)
    except Exception as exc:
        logger.error("Token exchange error: %s", exc)
        raise HTTPException(status_code=500, detail="Token exchange failed")

    # Store the tokens in Token Vault for the default instance
    vault = get_vault()
    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token", "")

    if refresh_token:
        vault.store_refresh_token(DEFAULT_INSTANCE, refresh_token)
    if access_token:
        vault.store_access_token(DEFAULT_INSTANCE, access_token)

    logger.info(
        "OAuth callback: stored tokens for default instance (access=%s, refresh=%s)",
        bool(access_token), bool(refresh_token),
    )

    # Return a self-closing page that signals the parent dashboard
    return HTMLResponse(content="""
    <html><body>
    <h2 style="font-family: system-ui; color: #10b981;">Connected successfully!</h2>
    <p style="font-family: system-ui; color: #666;">This window will close automatically.</p>
    <script>
        if (window.opener) {
            window.opener.postMessage({ type: 'auth0-callback', success: true }, '*');
            setTimeout(() => window.close(), 1500);
        }
    </script>
    </body></html>
    """, status_code=200)


@router.get("/status")
async def vault_status():
    """
    Return the current Token Vault status — mode, Auth0 domain, active connections.
    Used by the dashboard to display real-time vault state.
    """
    vault = get_vault()
    connections = vault.list_connections(DEFAULT_INSTANCE)
    detector = get_detector(DEFAULT_INSTANCE)

    return {
        "token_vault_mode": "auth0" if (AUTH0_DOMAIN and not vault.demo_mode) else "demo",
        "auth0_domain": AUTH0_DOMAIN or "not configured",
        "active_connections": len(connections),
        "connections": connections,
        "anomaly_detector": detector.summary(),
    }


# ---------------------------------------------------------------------------
# Instance-specific routes (original API)
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
        params = {
            "response_type": "code",
            "client_id": AUTH0_CLIENT_ID,
            "redirect_uri": AUTH0_REDIRECT,
            "scope": "openid profile email offline_access " + " ".join(scopes),
            "connection": connection,
            "access_type": "offline",
            "prompt": "consent",
            "state": f"{instance_id}:{service}",
        }
        auth_url = f"https://{AUTH0_DOMAIN}/authorize?{urlencode(params)}"
        return {
            "action": "redirect",
            "auth_url": auth_url,
            "message": "Redirect user to auth_url to complete the Auth0 Connected Accounts OAuth flow.",
        }

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
            "In production this triggers an Auth0 Connected Accounts OAuth flow. "
            "Raw credential never leaves the vault."
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
    return {"revoked": True, "connection": body.scope, "message": f"Token for '{body.scope}' has been revoked."}


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
