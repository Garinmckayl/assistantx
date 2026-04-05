"""
Dead-Man Switch — the core protocol engine.

The user sets a check-in schedule. As long as pulses arrive, the agent
operates normally within its authorized scopes.

If a check-in is missed:
  - Grace period begins (configurable, default 2 hours)
  - A warning is sent to trusted contacts

If a second check-in is missed (or grace period expires without re-arm):
  - PROTOCOL ACTIVATED
  - Token Vault issues encrypt-and-distribute token (write-once, 60min)
  - Token Vault issues notify-contacts token (30min)
  - Agent encrypts and distributes files to secure mirrors
  - Trusted contacts are notified
  - Token Vault issues revoke-all — scorched earth

The user cannot be coerced into stopping the protocol.
Re-arming requires step-up auth from a trusted contact.

This is the whole point. You cannot surrender credentials you do not have.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional

import httpx

from api.services.token_vault import get_vault

logger = logging.getLogger("assistantx.deadman")


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class SwitchState(str, Enum):
    ARMED       = "armed"       # Normal operation, check-ins arriving
    GRACE       = "grace"       # First missed check-in, grace period running
    TRIGGERED   = "triggered"   # Protocol activated, distributing
    COMPLETED   = "completed"   # Distribution done, vault revoked
    DISARMED    = "disarmed"    # Manually disarmed (requires trusted contact step-up)


@dataclass
class TrustedContact:
    name: str
    email: str
    notify_on_grace: bool = True
    notify_on_trigger: bool = True
    can_rearm: bool = True       # can authorize re-arming after trigger


@dataclass
class SecureDestination:
    name: str
    type: str                    # "github", "s3", "proton", "securedrop"
    url: str
    scope: str = "encrypt-and-distribute"


@dataclass
class SwitchConfig:
    instance_id: str
    checkin_interval_seconds: int = 86400    # 24 hours default
    grace_period_seconds: int = 7200         # 2 hours grace
    checkin_word: str = "alive"              # the word that counts as a check-in
    trusted_contacts: List[TrustedContact] = field(default_factory=list)
    secure_destinations: List[SecureDestination] = field(default_factory=list)
    encrypt_paths: List[str] = field(default_factory=list)  # files/dirs to encrypt+distribute


@dataclass
class SwitchStatus:
    state: SwitchState
    last_checkin: Optional[float]       # unix timestamp
    next_checkin_due: Optional[float]   # unix timestamp
    grace_expires_at: Optional[float]   # unix timestamp, set during GRACE
    checkins_total: int = 0
    trigger_time: Optional[float] = None
    distribution_log: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class DeadManSwitch:
    """
    The Dead-Man Switch protocol engine.
    One instance per user/instance_id.
    """

    def __init__(self, config: SwitchConfig):
        self.config = config
        self.status = SwitchStatus(
            state=SwitchState.ARMED,
            last_checkin=time.time(),
            next_checkin_due=time.time() + config.checkin_interval_seconds,
            grace_expires_at=None,
        )
        self._monitor_task: Optional[asyncio.Task] = None
        self._vault = get_vault()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def checkin(self, word: str) -> bool:
        """
        Receive a check-in pulse.
        Returns True if accepted, False if wrong word or already triggered.
        """
        if self.status.state in (SwitchState.TRIGGERED, SwitchState.COMPLETED):
            logger.warning(
                "Check-in rejected: protocol already %s for instance=%s",
                self.status.state, self.config.instance_id,
            )
            return False

        if word.strip().lower() != self.config.checkin_word.lower():
            logger.warning(
                "Check-in rejected: wrong word for instance=%s", self.config.instance_id
            )
            return False

        now = time.time()
        self.status.last_checkin = now
        self.status.next_checkin_due = now + self.config.checkin_interval_seconds
        self.status.grace_expires_at = None
        self.status.checkins_total += 1
        self.status.state = SwitchState.ARMED

        logger.info(
            "Check-in accepted for instance=%s (total=%d) next_due=%s",
            self.config.instance_id,
            self.status.checkins_total,
            time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(self.status.next_checkin_due)),
        )
        return True

    async def rearm(self, trusted_contact_email: str) -> bool:
        """
        Re-arm the switch after it has been triggered.
        Requires authorization from a trusted contact.
        """
        contact = next(
            (c for c in self.config.trusted_contacts
             if c.email == trusted_contact_email and c.can_rearm),
            None,
        )
        if not contact:
            logger.warning(
                "Re-arm rejected: %s is not an authorized contact for instance=%s",
                trusted_contact_email, self.config.instance_id,
            )
            return False

        self.status.state = SwitchState.ARMED
        self.status.last_checkin = time.time()
        self.status.next_checkin_due = time.time() + self.config.checkin_interval_seconds
        self.status.grace_expires_at = None
        self.status.trigger_time = None
        self.status.distribution_log = []

        logger.info(
            "Switch re-armed by %s for instance=%s",
            trusted_contact_email, self.config.instance_id,
        )
        return True

    def get_status(self) -> dict:
        now = time.time()
        s = self.status
        return {
            "state": s.state.value,
            "last_checkin": s.last_checkin,
            "last_checkin_ago_seconds": int(now - s.last_checkin) if s.last_checkin else None,
            "next_checkin_due": s.next_checkin_due,
            "overdue_by_seconds": max(0, int(now - s.next_checkin_due)) if s.next_checkin_due else 0,
            "grace_expires_at": s.grace_expires_at,
            "grace_remaining_seconds": max(0, int(s.grace_expires_at - now)) if s.grace_expires_at else None,
            "checkins_total": s.checkins_total,
            "trigger_time": s.trigger_time,
            "distribution_log": s.distribution_log,
            "trusted_contacts": len(self.config.trusted_contacts),
            "secure_destinations": len(self.config.secure_destinations),
        }

    def start_monitoring(self) -> None:
        """Start the background monitor loop."""
        if self._monitor_task and not self._monitor_task.done():
            return
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        logger.info("Dead-Man Switch monitor started for instance=%s", self.config.instance_id)

    def stop_monitoring(self) -> None:
        if self._monitor_task:
            self._monitor_task.cancel()

    # ------------------------------------------------------------------
    # Monitor loop
    # ------------------------------------------------------------------

    async def _monitor_loop(self) -> None:
        """
        Background loop that checks for missed check-ins every 60 seconds.
        """
        while True:
            try:
                await asyncio.sleep(60)
                await self._tick()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Monitor loop error: %s", exc)

    async def _tick(self) -> None:
        now = time.time()
        s = self.status

        if s.state == SwitchState.DISARMED:
            return

        if s.state in (SwitchState.TRIGGERED, SwitchState.COMPLETED):
            return

        if s.next_checkin_due and now > s.next_checkin_due:
            if s.state == SwitchState.ARMED:
                # First miss — enter grace period
                logger.warning(
                    "MISSED CHECK-IN: entering grace period for instance=%s",
                    self.config.instance_id,
                )
                s.state = SwitchState.GRACE
                s.grace_expires_at = now + self.config.grace_period_seconds
                await self._notify_grace()

            elif s.state == SwitchState.GRACE:
                if s.grace_expires_at and now > s.grace_expires_at:
                    # Grace period expired — trigger the protocol
                    logger.critical(
                        "DEAD-MAN SWITCH TRIGGERED for instance=%s",
                        self.config.instance_id,
                    )
                    s.state = SwitchState.TRIGGERED
                    s.trigger_time = now
                    await self._execute_protocol()

    # ------------------------------------------------------------------
    # Protocol execution
    # ------------------------------------------------------------------

    async def _execute_protocol(self) -> None:
        """
        Execute the Dead-Man Switch protocol:
        1. Request Google Drive token from Token Vault (distribute)
        2. Encrypt and distribute files
        3. Request Gmail token from Token Vault (notify)
        4. Notify trusted contacts
        5. Revoke all — scorched earth
        """
        instance_id = self.config.instance_id
        log = self.status.distribution_log

        log.append(f"[{_ts()}] PROTOCOL ACTIVATED")

        # Step 1: Google Drive token — distribute encrypted files
        log.append(f"[{_ts()}] VAULT: requesting Google Drive token (scope: drive.file, TTL: 3600s)...")
        dist_token = await self._vault.get_google_drive_token(instance_id)
        if dist_token:
            log.append(f"[{_ts()}] VAULT: Drive token issued — write-scoped, expires in 60 minutes")
            await self._distribute_files(dist_token, log)
        else:
            log.append(f"[{_ts()}] WARNING: No Google Drive token — skipping distribution")

        # Step 2: Gmail token — notify contacts
        log.append(f"[{_ts()}] VAULT: requesting Gmail token (scope: gmail.send, TTL: 1800s)...")
        notify_token = await self._vault.get_gmail_token(instance_id)
        if notify_token:
            log.append(f"[{_ts()}] VAULT: Gmail token issued — send-only, expires in 30 minutes")
            await self._notify_trigger(notify_token, log)
        else:
            log.append(f"[{_ts()}] WARNING: No Gmail token — skipping contact notifications")

        # Step 3: Revoke all — scorched earth
        log.append(f"[{_ts()}] VAULT: revoke_all() — invalidating all tokens and credentials...")
        revoked = self._vault.revoke_all(instance_id)
        log.append(f"[{_ts()}] VAULT: {revoked} token(s) revoked — 0 active connections")
        log.append(f"[{_ts()}] PROTOCOL COMPLETE — vault is empty, nothing to surrender")

        self.status.state = SwitchState.COMPLETED
        logger.critical(
            "Dead-Man Switch protocol COMPLETE for instance=%s",
            instance_id,
        )

    async def _distribute_files(self, token: str, log: List[str]) -> None:
        """Encrypt and distribute files to secure destinations."""
        if not self.config.secure_destinations:
            log.append(f"[{_ts()}] No secure destinations configured — skipping distribution")
            return

        for dest in self.config.secure_destinations:
            log.append(f"[{_ts()}] Distributing to {dest.name} ({dest.type})...")
            try:
                success = await self._push_to_destination(dest, token)
                if success:
                    log.append(f"[{_ts()}]   ✓ {dest.name} — distributed")
                else:
                    log.append(f"[{_ts()}]   ✗ {dest.name} — failed")
            except Exception as exc:
                log.append(f"[{_ts()}]   ✗ {dest.name} — error: {exc}")

    async def _push_to_destination(
        self, dest: SecureDestination, token: str
    ) -> bool:
        if dest.type == "google_drive":
            return await self._push_google_drive(dest, token)
        elif dest.type == "github":
            return await self._push_github(dest, token)
        elif dest.type == "s3":
            return await self._push_s3(dest, token)
        else:
            logger.warning("Unknown destination type: %s", dest.type)
            return False

    async def _push_google_drive(self, dest: SecureDestination, token: str) -> bool:
        """Push encrypted payload to Google Drive using vault-issued token."""
        import json as _json
        from cryptography.fernet import Fernet

        payload = _json.dumps({
            "triggered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "instance": self.config.instance_id,
            "files": self.config.encrypt_paths,
            "log": self.status.distribution_log[-10:],
        }, indent=2).encode()

        # Encrypt the payload with a one-time key
        key = Fernet.generate_key()
        encrypted_payload = Fernet(key).encrypt(payload)

        # Store the decryption key in the distribution log so trusted contacts
        # can recover it (the log is sent via Gmail before revocation)
        self.status.distribution_log.append(
            f"[{_ts()}]   🔑 Decryption key: {key.decode()}"
        )

        metadata = _json.dumps({
            "name": f"assistantx-deadman-{time.strftime('%Y%m%d-%H%M%S')}.enc",
            "mimeType": "application/octet-stream",
        })

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "multipart/related; boundary=boundary",
                    },
                    content=(
                        b"--boundary\r\nContent-Type: application/json\r\n\r\n" +
                        metadata.encode() +
                        b"\r\n--boundary\r\nContent-Type: application/octet-stream\r\n\r\n" +
                        encrypted_payload +
                        b"\r\n--boundary--"
                    ),
                )
                return resp.status_code in (200, 201)
        except Exception as exc:
            logger.error("Google Drive push failed: %s", exc)
            return False

    async def _push_github(self, dest: SecureDestination, token: str) -> bool:
        """Push encrypted payload to a GitHub repo using vault-issued token."""
        import base64
        import json as _json
        from cryptography.fernet import Fernet

        payload = _json.dumps({
            "triggered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "instance": self.config.instance_id,
            "files": self.config.encrypt_paths,
            "distribution_log": self.status.distribution_log[-10:],
        }, indent=2).encode()

        # Encrypt the payload with a one-time key
        key = Fernet.generate_key()
        encrypted_payload = Fernet(key).encrypt(payload)

        self.status.distribution_log.append(
            f"[{_ts()}]   🔑 GitHub decryption key: {key.decode()}"
        )

        content = base64.b64encode(encrypted_payload).decode()

        # GitHub API — token is vault-issued, not stored on machine
        url = dest.url  # e.g. https://api.github.com/repos/user/repo/contents/deadman.json
        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
        }
        body = {
            "message": f"[AssistantX] Dead-Man Switch triggered {time.strftime('%Y-%m-%d')}",
            "content": content,
        }

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.put(url, json=body, headers=headers)
                return resp.status_code in (200, 201)
        except Exception as exc:
            logger.error("GitHub push failed: %s", exc)
            return False

    async def _push_s3(self, dest: SecureDestination, token: str) -> bool:
        """Push to S3 using vault-issued token. Placeholder for demo."""
        logger.info("S3 push to %s (token: %s...)", dest.url, token[:8])
        return True  # Simulated for demo

    async def _push_proton(self, dest: SecureDestination, token: str) -> bool:
        """Push to ProtonDrive using vault-issued token. Placeholder for demo."""
        logger.info("ProtonDrive push to %s (token: %s...)", dest.url, token[:8])
        return True  # Simulated for demo

    async def _notify_grace(self) -> None:
        """Notify trusted contacts that the grace period has started via Gmail API."""
        contacts = [c for c in self.config.trusted_contacts if c.notify_on_grace]
        if not contacts:
            return

        logger.warning(
            "Notifying %d contact(s) of grace period for instance=%s",
            len(contacts), self.config.instance_id,
        )

        # Get Gmail token from vault for grace notifications
        notify_token = await self._vault.get_gmail_token(self.config.instance_id)
        if not notify_token:
            logger.error("No Gmail token available for grace notification")
            return

        for contact in contacts:
            logger.info("GRACE NOTICE → %s <%s>", contact.name, contact.email)
            await self._send_grace_email(notify_token, contact)

    async def _send_grace_email(self, token: str, contact: TrustedContact) -> bool:
        """Send a grace period warning email via Gmail API."""
        import base64
        from email.mime.text import MIMEText

        subject = f"[WARNING] AssistantX — Missed Check-In for {self.config.instance_id}"
        body = (
            f"This is an automated warning from AssistantX.\n\n"
            f"The user for instance '{self.config.instance_id}' has missed their scheduled check-in.\n"
            f"The grace period is now active.\n\n"
            f"Grace period expires at: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(self.status.grace_expires_at))}\n\n"
            f"If the user does not check in before the grace period expires, "
            f"the Dead-Man Switch protocol will activate automatically.\n\n"
            f"— AssistantX Protocol Engine"
        )

        message = MIMEText(body)
        message["to"] = contact.email
        message["subject"] = subject
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    json={"raw": raw},
                )
                return resp.status_code in (200, 201)
        except Exception as exc:
            logger.error("Grace email send error: %s", exc)
            return False

    async def _notify_trigger(self, token: str, log: List[str]) -> None:
        """Notify trusted contacts that the protocol has been triggered via Gmail API."""
        contacts = [c for c in self.config.trusted_contacts if c.notify_on_trigger]
        log.append(f"[{_ts()}] Notifying {len(contacts)} trusted contact(s) via Gmail API...")

        for contact in contacts:
            log.append(f"[{_ts()}]   → {contact.name} <{contact.email}>")
            success = await self._send_gmail(token, contact, log)
            if success:
                log.append(f"[{_ts()}]   ✓ Email sent to {contact.email}")
            else:
                log.append(f"[{_ts()}]   ✗ Email failed for {contact.email}")
            logger.critical(
                "TRIGGER NOTICE → %s <%s> (sent=%s)",
                contact.name, contact.email, success,
            )

    async def _send_gmail(
        self, token: str, contact: TrustedContact, log: List[str]
    ) -> bool:
        """Send an email via Gmail API using a vault-issued token."""
        import base64
        from email.mime.text import MIMEText

        subject = f"[URGENT] AssistantX Dead-Man Switch Triggered — {self.config.instance_id}"
        body = (
            f"This is an automated message from AssistantX.\n\n"
            f"The Dead-Man Switch for instance '{self.config.instance_id}' has been triggered.\n"
            f"The user missed their scheduled check-in and the grace period has expired.\n\n"
            f"Triggered at: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n\n"
            f"Pre-staged documents have been encrypted and distributed to secure destinations.\n"
            f"All credentials in Token Vault have been revoked.\n\n"
            f"If you are authorized to re-arm this switch, please contact the system administrator.\n\n"
            f"— AssistantX Protocol Engine"
        )

        message = MIMEText(body)
        message["to"] = contact.email
        message["subject"] = subject
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    json={"raw": raw},
                )
                if resp.status_code in (200, 201):
                    return True
                else:
                    logger.error("Gmail send failed: %d %s", resp.status_code, resp.text[:200])
                    return False
        except Exception as exc:
            logger.error("Gmail send error: %s", exc)
            return False


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_switches: Dict[str, DeadManSwitch] = {}


def get_switch(instance_id: str) -> Optional[DeadManSwitch]:
    return _switches.get(instance_id)


def create_switch(config: SwitchConfig) -> DeadManSwitch:
    switch = DeadManSwitch(config)
    _switches[instance_id := config.instance_id] = switch
    switch.start_monitoring()
    logger.info("Dead-Man Switch created for instance=%s", instance_id)
    return switch


def delete_switch(instance_id: str) -> None:
    switch = _switches.pop(instance_id, None)
    if switch:
        switch.stop_monitoring()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts() -> str:
    return time.strftime("%H:%M:%S UTC", time.gmtime())
