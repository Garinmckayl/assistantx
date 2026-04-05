"""
Auth0 Token Vault — real integration using auth0-ai Python SDK.

The Dead-Man Switch uses Token Vault to hold credentials for external services
(GitHub, ProtonDrive, S3). When the protocol triggers, the agent exchanges
the user's stored Auth0 token for a scoped external-provider token.

The user never holds these credentials. The vault does.
You cannot surrender credentials you do not have.

Flow:
  1. User authenticates with Auth0 (refresh token issued)
  2. User connects their GitHub/external account via Connected Accounts
  3. Token Vault stores the external provider's tokens
  4. On Dead-Man trigger: backend calls access_token_for_connection()
     to exchange the Auth0 token for a GitHub/S3/etc token
  5. Agent uses that scoped token to push files — then it expires

Real SDK: auth0-ai (pip install auth0-ai)
Real API: auth0.GetToken.access_token_for_connection()
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

from api.services.anomaly import (
    VaultAccessEvent,
    AnomalyResult,
    get_detector,
)

logger = logging.getLogger("assistantx.token_vault")

# ---------------------------------------------------------------------------
# Token Scopes — maps to Auth0 connection names + OAuth scopes
# ---------------------------------------------------------------------------

class ConnectionScope:
    """Auth0 connection names and their required scopes for Dead-Man Switch."""

    # Google Drive: store encrypted payload in user's Drive
    GOOGLE_DRIVE = "google-oauth2"
    GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"]

    # Gmail: notify trusted contacts
    GMAIL = "google-oauth2"
    GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


# ---------------------------------------------------------------------------
# Local token cache (TTL-based, no persistence — intentional)
# ---------------------------------------------------------------------------

@dataclass
class CachedToken:
    access_token: str
    connection: str
    expires_at: float
    scopes: List[str] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return time.time() < self.expires_at - 30  # 30s buffer


# ---------------------------------------------------------------------------
# Token Vault Client
# ---------------------------------------------------------------------------

class TokenVaultClient:
    """
    Auth0 Token Vault client — wraps the auth0-ai SDK's token exchange.

    In production:
        Uses auth0.GetToken.access_token_for_connection() to exchange
        the user's Auth0 refresh/access token for an external provider token.

    In demo mode (no AUTH0_DOMAIN set):
        Returns placeholder tokens so the rest of the system can be tested.
    """

    def __init__(self):
        self.domain        = os.getenv("AUTH0_DOMAIN", "")
        self.client_id     = os.getenv("AUTH0_CLIENT_ID", "")
        self.client_secret = os.getenv("AUTH0_CLIENT_SECRET", "")
        self.demo_mode     = not all([self.domain, self.client_id, self.client_secret])

        # Per-instance refresh token store (set when user authenticates)
        # instance_id -> refresh_token
        self._refresh_tokens: Dict[str, str] = {}

        # Per-instance access token store (set when user authenticates with access token)
        self._access_tokens: Dict[str, str] = {}

        # Token cache: instance_id -> connection -> CachedToken
        self._cache: Dict[str, Dict[str, CachedToken]] = {}

        # Authorized connections via Auth0 OAuth (persists until revoked)
        # instance_id -> connection -> { scopes, connected_at }
        self._authorized: Dict[str, Dict[str, Dict]] = {}

        # OpenClaw API credentials (stored until first use)
        self._openclaw_creds: Dict[str, Dict[str, str]] = {}

        # Google provider tokens (stored from OAuth callback for direct API access)
        # instance_id -> { access_token, refresh_token }
        self._google_tokens: Dict[str, Dict[str, str]] = {}

        if self.demo_mode:
            logger.warning(
                "Token Vault: DEMO MODE — set AUTH0_DOMAIN, AUTH0_CLIENT_ID, "
                "AUTH0_CLIENT_SECRET for real token exchange."
            )
        else:
            logger.info(
                "Token Vault: production mode — Auth0 domain: %s", self.domain
            )

    # ------------------------------------------------------------------
    # Auth token storage (called when user authenticates)
    # ------------------------------------------------------------------

    def store_refresh_token(self, instance_id: str, refresh_token: str) -> None:
        """Store a user's Auth0 refresh token for later vault exchanges."""
        self._refresh_tokens[instance_id] = refresh_token
        logger.info("Stored refresh token for instance=%s", instance_id)

    def store_access_token(self, instance_id: str, access_token: str) -> None:
        """Store a user's Auth0 access token for vault exchanges."""
        self._access_tokens[instance_id] = access_token
        logger.info("Stored access token for instance=%s", instance_id)

    def mark_connection_authorized(
        self, instance_id: str, connection: str, scopes: List[str]
    ) -> None:
        """Record that a connection was authorized via Auth0 OAuth."""
        self._authorized.setdefault(instance_id, {})[connection] = {
            "scopes": scopes,
            "connected_at": time.time(),
        }
        logger.info(
            "Marked connection=%s as authorized for instance=%s",
            connection, instance_id,
        )

    def revoke_connection(self, instance_id: str, connection: str) -> bool:
        """Revoke an authorized connection."""
        removed = False
        auth = self._authorized.get(instance_id, {})
        if connection in auth:
            del auth[connection]
            removed = True
        cache = self._cache.get(instance_id, {})
        if connection in cache:
            del cache[connection]
            removed = True
        if removed:
            logger.info("Revoked connection=%s for instance=%s", connection, instance_id)
        return removed

    def store_openclaw_credentials(
        self, instance_id: str, credentials: Dict[str, str]
    ) -> None:
        """
        Store OpenClaw API credentials.
        These are never injected into the container — fetched per-request.
        """
        self._openclaw_creds[instance_id] = {
            k: v for k, v in credentials.items() if v
        }
        logger.info(
            "Stored %d OpenClaw credential(s) for instance=%s",
            len(self._openclaw_creds[instance_id]), instance_id,
        )

    # ------------------------------------------------------------------
    # Token exchange — the core Token Vault operation
    # ------------------------------------------------------------------

    async def get_access_token_for_connection(
        self,
        instance_id: str,
        connection: str,
        scopes: List[str],
        trigger: str = "normal",
    ) -> Tuple[Optional[str], Optional[AnomalyResult]]:
        """
        Exchange the user's Auth0 token for an external provider token.

        This is the core Token Vault operation:
          Auth0 refresh/access token → external provider access token

        Also scores the request against the behavioral anomaly detector.
        Returns (token, anomaly_result) — anomaly_result is None during cold start.
        """
        # --- Behavioral anomaly detection ---
        event = VaultAccessEvent(
            instance_id=instance_id,
            connection=connection,
            scopes=scopes,
            trigger=trigger,
        )
        detector = get_detector(instance_id)
        anomaly = detector.record_and_score(event)

        if anomaly and anomaly.anomalous:
            logger.critical(
                "Token Vault: ANOMALOUS REQUEST — instance=%s connection=%s "
                "score=%.3f reason=%s",
                instance_id, connection, anomaly.score, anomaly.reason,
            )

        # --- Check cache ---
        cached = self._cache.get(instance_id, {}).get(connection)
        if cached and cached.is_valid:
            logger.debug(
                "Token Vault cache hit: instance=%s connection=%s",
                instance_id, connection,
            )
            return cached.access_token, anomaly

        if self.demo_mode:
            return self._demo_token(instance_id, connection, scopes), anomaly

        token = await self._exchange_token(instance_id, connection, scopes)
        return token, anomaly

    async def _exchange_token(
        self,
        instance_id: str,
        connection: str,
        scopes: List[str],
    ) -> Optional[str]:
        """
        Real Token Vault exchange via Auth0 API.
        Uses auth0-python GetToken.access_token_for_connection().
        """
        from auth0.authentication import GetToken
        from auth0_ai.credentials import TokenResponse
        from auth0_ai.interrupts.token_vault_interrupt import TokenVaultInterrupt

        refresh_token = self._refresh_tokens.get(instance_id)
        access_token  = self._access_tokens.get(instance_id)

        if not refresh_token and not access_token:
            logger.error(
                "Token Vault: no auth token for instance=%s — "
                "user must authenticate first",
                instance_id,
            )
            return None

        get_token = GetToken(
            domain=self.domain,
            client_id=self.client_id,
            client_secret=self.client_secret,
        )

        from auth0_ai.authorizers.token_vault_authorizer import (
            SUBJECT_TYPE_REFRESH_TOKEN,
            SUBJECT_TYPE_ACCESS_TOKEN,
            REQUESTED_TOKEN_TYPE_TOKEN_VAULT_ACCESS_TOKEN,
        )

        try:
            if refresh_token:
                response = get_token.access_token_for_connection(
                    subject_token_type=SUBJECT_TYPE_REFRESH_TOKEN,
                    subject_token=refresh_token,
                    requested_token_type=REQUESTED_TOKEN_TYPE_TOKEN_VAULT_ACCESS_TOKEN,
                    connection=connection,
                )
            else:
                response = get_token.access_token_for_connection(
                    subject_token_type=SUBJECT_TYPE_ACCESS_TOKEN,
                    subject_token=access_token,
                    requested_token_type=REQUESTED_TOKEN_TYPE_TOKEN_VAULT_ACCESS_TOKEN,
                    connection=connection,
                )

            ext_token = response["access_token"]
            expires_in = response.get("expires_in", 3600)

            # Cache it
            self._cache.setdefault(instance_id, {})[connection] = CachedToken(
                access_token=ext_token,
                connection=connection,
                expires_at=time.time() + expires_in,
                scopes=scopes,
            )

            logger.info(
                "Token Vault: issued %s token for instance=%s (expires_in=%ds)",
                connection, instance_id, expires_in,
            )
            return ext_token

        except Exception as exc:
            logger.error(
                "Token Vault exchange failed for instance=%s connection=%s: %s",
                instance_id, connection, exc,
            )
            return None

    def store_google_provider_token(self, instance_id: str, access_token: str, refresh_token: str = "") -> None:
        """Store Google provider tokens obtained from OAuth for direct API access."""
        self._google_tokens[instance_id] = {
            "access_token": access_token,
            "refresh_token": refresh_token,
        }
        logger.info("Stored Google provider token for instance=%s", instance_id)

    def _get_google_provider_token(self, instance_id: str) -> Optional[str]:
        """Get stored Google provider access token as fallback."""
        entry = self._google_tokens.get(instance_id)
        if entry and entry.get("access_token"):
            return entry["access_token"]
        return None

    # ------------------------------------------------------------------
    # Convenience methods for Dead-Man Switch
    # ------------------------------------------------------------------

    async def get_google_drive_token(self, instance_id: str) -> Optional[str]:
        """Get a Google Drive token for pushing encrypted files."""
        token, _ = await self.get_access_token_for_connection(
            instance_id,
            ConnectionScope.GOOGLE_DRIVE,
            ConnectionScope.GOOGLE_DRIVE_SCOPES,
            trigger="deadman",
        )
        if not token:
            # Fallback: use stored Google provider token directly
            token = self._get_google_provider_token(instance_id)
            if token:
                logger.info("Using Google provider token fallback for Drive (instance=%s)", instance_id)
        return token

    async def get_gmail_token(self, instance_id: str) -> Optional[str]:
        """Get a Gmail token for notifying trusted contacts."""
        token, _ = await self.get_access_token_for_connection(
            instance_id,
            ConnectionScope.GMAIL,
            ConnectionScope.GMAIL_SCOPES,
            trigger="deadman",
        )
        if not token:
            # Fallback: use stored Google provider token directly
            token = self._get_google_provider_token(instance_id)
            if token:
                logger.info("Using Google provider token fallback for Gmail (instance=%s)", instance_id)
        return token

    # ------------------------------------------------------------------
    # OpenClaw credential management
    # ------------------------------------------------------------------

    def get_openclaw_credentials(self, instance_id: str) -> Dict[str, str]:
        """
        Return OpenClaw API credentials for this instance.
        Fetched from in-memory store — never written to the container.
        Records a vault access event for behavioral tracking.
        """
        event = VaultAccessEvent(
            instance_id=instance_id,
            connection="openclaw-credentials",
            scopes=list(self._openclaw_creds.get(instance_id, {}).keys()),
            trigger="normal",
        )
        get_detector(instance_id).record_and_score(event)
        return dict(self._openclaw_creds.get(instance_id, {}))

    # ------------------------------------------------------------------
    # Revocation
    # ------------------------------------------------------------------

    def revoke_all(self, instance_id: str) -> int:
        """
        Revoke all cached tokens and credentials for an instance.
        Called as the final step of the Dead-Man Switch protocol.

        1. Revoke refresh token at Auth0's /oauth/revoke endpoint
        2. Clear all local caches and stored tokens
        """
        count = 0

        # Step 1: Revoke refresh token at Auth0 if we have one
        refresh_token = self._refresh_tokens.get(instance_id)
        if refresh_token and not self.demo_mode:
            try:
                import httpx
                resp = httpx.post(
                    f"https://{self.domain}/oauth/revoke",
                    json={
                        "client_id": self.client_id,
                        "client_secret": self.client_secret,
                        "token": refresh_token,
                    },
                    headers={"Content-Type": "application/json"},
                    timeout=10,
                )
                if resp.status_code == 200:
                    logger.info(
                        "Auth0 refresh token revoked remotely for instance=%s",
                        instance_id,
                    )
                else:
                    logger.warning(
                        "Auth0 revoke returned %d for instance=%s: %s",
                        resp.status_code, instance_id, resp.text[:200],
                    )
            except Exception as exc:
                logger.error(
                    "Auth0 remote revocation failed for instance=%s: %s",
                    instance_id, exc,
                )

        # Step 2: Clear all local state
        if instance_id in self._cache:
            count += len(self._cache.pop(instance_id))
        if instance_id in self._refresh_tokens:
            del self._refresh_tokens[instance_id]
            count += 1
        if instance_id in self._access_tokens:
            del self._access_tokens[instance_id]
            count += 1
        if instance_id in self._openclaw_creds:
            del self._openclaw_creds[instance_id]
            count += 1
        if instance_id in self._authorized:
            count += len(self._authorized.pop(instance_id))
        if instance_id in self._google_tokens:
            del self._google_tokens[instance_id]
            count += 1
        logger.info("Revoked %d token(s)/credential(s) for instance=%s", count, instance_id)
        return count

    def list_connections(self, instance_id: str) -> List[Dict]:
        """Return a sanitised list of active connections (no raw tokens)."""
        result = []
        seen = set()

        # Cached tokens (actively exchanged)
        for connection, cached in self._cache.get(instance_id, {}).items():
            if cached.is_valid:
                result.append({
                    "connection": connection,
                    "scopes": cached.scopes,
                    "expires_in_seconds": max(0, int(cached.expires_at - time.time())),
                    "valid": True,
                    "source": "cache",
                })
                seen.add(connection)

        # Authorized via Auth0 OAuth (may not have cached token yet)
        for connection, info in self._authorized.get(instance_id, {}).items():
            if connection not in seen:
                result.append({
                    "connection": connection,
                    "scopes": info.get("scopes", []),
                    "expires_in_seconds": -1,  # managed by Auth0
                    "valid": True,
                    "source": "auth0",
                })
                seen.add(connection)

        has_openclaw = bool(self._openclaw_creds.get(instance_id))
        if has_openclaw:
            result.append({
                "connection": "openclaw-credentials",
                "scopes": list(self._openclaw_creds[instance_id].keys()),
                "expires_in_seconds": -1,   # no expiry
                "valid": True,
                "source": "local",
            })
        return result

    # ------------------------------------------------------------------
    # Demo mode
    # ------------------------------------------------------------------

    def _demo_token(
        self,
        instance_id: str,
        connection: str,
        scopes: List[str],
        ttl: int = 3600,
    ) -> str:
        """Issue a demo placeholder token (never a real credential)."""
        import secrets as _s
        token = f"demo-vault-{connection}-{_s.token_urlsafe(16)}"
        self._cache.setdefault(instance_id, {})[connection] = CachedToken(
            access_token=token,
            connection=connection,
            expires_at=time.time() + ttl,
            scopes=scopes,
        )
        logger.debug(
            "DEMO vault issued %s token for instance=%s", connection, instance_id
        )
        return token


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_vault_client: Optional[TokenVaultClient] = None


def get_vault() -> TokenVaultClient:
    global _vault_client
    if _vault_client is None:
        _vault_client = TokenVaultClient()
    return _vault_client
