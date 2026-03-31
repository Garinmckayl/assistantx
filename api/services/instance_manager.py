"""
Instance manager — lifecycle of isolated OpenClaw Docker containers.

Architecture
============
Each AssistantX instance = one Docker container running the assistantx/openclaw image.
The container runs `openclaw gateway run` as a persistent background process,
listening on port 18789 (mapped to a unique host port per instance).

Messages are sent to the gateway via WebSocket directly from Python —
no `docker exec` overhead per message. Response time: ~2-3s (just the LLM call).

Isolation
=========
Each container has its own:
- Filesystem (Docker image layer + writable container layer)
- /root/.openclaw config directory (scaffolded at instance creation)
- openclaw session state (session history, memory, workspace)
- Resource limits: 1.5 GB RAM, 0.75 vCPU
- kernel-level isolation — container A cannot access container B's memory
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import uuid
from datetime import datetime, timezone
from typing import Dict, Optional

import docker
import docker.errors
from docker.models.containers import Container

from api.models import Instance, InstanceConfig, InstanceStatus

logger = logging.getLogger("assistantx.instance_manager")

OPENCLAW_IMAGE = os.getenv("OPENCLAW_IMAGE", "assistantx/openclaw:latest")
MAX_INSTANCES  = int(os.getenv("MAX_INSTANCES", "10"))
DEFAULT_GEMINI = os.getenv("GEMINI_API_KEY", os.getenv("GOOGLE_GENERATIVE_AI_API_KEY", ""))

STATE_FILE = pathlib.Path(os.getenv("ASSISTANTX_STATE_FILE", "/root/assistantx/.instances.json"))


class InstanceManager:
    def __init__(self):
        self._instances: Dict[str, Instance] = {}
        self._containers: Dict[str, Container] = {}
        self._lock = asyncio.Lock()
        self._port_counter = 0
        self._docker: Optional[docker.DockerClient] = None
        # Respect ASSISTANTX_MODE env — default docker, override to profile to skip Docker
        self._mode = os.getenv("ASSISTANTX_MODE", "docker")
        self._load_state()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _container_exists(self, instance_id: str) -> bool:
        """Check whether the Docker container for this instance is running."""
        if not self._docker:
            return False
        try:
            ctr = self._docker.containers.get(f"assistantx-{instance_id}")
            return ctr.status in ("running", "created", "restarting")
        except docker.errors.NotFound:
            return False
        except Exception:
            return False

    def _load_state(self):
        """Restore instance registry from disk on startup.
        Status is re-validated against actual runtime state after Docker connects.
        Called from __init__ (Docker not yet connected), so we load optimistically
        and fix up statuses in startup() once Docker is available.
        """
        if not STATE_FILE.exists():
            return
        try:
            data = json.loads(STATE_FILE.read_text())
            for d in data:
                inst = Instance(**d)
                # Optimistically mark as running; startup() will validate
                if inst.status == InstanceStatus.CREATING:
                    inst.status = InstanceStatus.RUNNING
                self._instances[inst.id] = inst
                if inst.proxy_port and inst.proxy_port > 20000:
                    self._port_counter = max(self._port_counter, inst.proxy_port - 20000)
            logger.info("Restored %d instances from disk", len(self._instances))
        except Exception as exc:
            logger.warning("Could not load instance state: %s", exc)

    def _validate_state(self):
        """After Docker connects, validate each instance's container is actually running."""
        changed = False
        for inst in self._instances.values():
            if inst.status in (InstanceStatus.RUNNING, InstanceStatus.ERROR):
                if self._mode == "docker":
                    ok = self._container_exists(inst.id)
                else:
                    profile_dir = pathlib.Path.home() / f".openclaw-assistantx-{inst.id}"
                    ok = profile_dir.exists()
                new_status = InstanceStatus.RUNNING if ok else InstanceStatus.ERROR
                if inst.status != new_status:
                    inst.status = new_status
                    changed = True
        if changed:
            self._save_state()

    def _save_state(self):
        """Persist instance registry to disk."""
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            data = [inst.model_dump(mode="json") for inst in self._instances.values()]
            STATE_FILE.write_text(json.dumps(data, indent=2, default=str))
            logger.debug("Saved state: %d instances", len(data))
        except Exception as exc:
            logger.error("Could not save instance state: %s", exc)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def startup(self):
        if self._mode == "profile":
            logger.info("ASSISTANTX_MODE=profile — skipping Docker, using host profiles")
            self._validate_state()
            self._save_state()
            return

        try:
            self._docker = docker.from_env()
            self._docker.ping()
            logger.info("Docker connected — mode: isolated containers")
            # Re-attach to existing containers so delete works after restart
            for inst in self._instances.values():
                try:
                    ctr = self._docker.containers.get(f"assistantx-{inst.id}")
                    self._containers[inst.id] = ctr
                    logger.debug("Re-attached container %s for instance %s", ctr.short_id, inst.id)
                except docker.errors.NotFound:
                    pass
            self._validate_state()
            self._save_state()
        except Exception as exc:
            logger.error("Docker unavailable: %s — falling back to profile mode", exc)
            self._mode = "profile"
            self._validate_state()
            self._save_state()

    async def shutdown(self):
        # Don't stop containers on shutdown — they restart automatically
        pass

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create_instance(self, config: InstanceConfig) -> Instance:
        async with self._lock:
            if len(self._instances) >= MAX_INSTANCES:
                raise RuntimeError(f"Maximum of {MAX_INSTANCES} instances reached")
            self._port_counter += 1
            instance_id = str(uuid.uuid4())[:8]
            instance = Instance(
                id=instance_id,
                name=config.name,
                status=InstanceStatus.CREATING,
                proxy_port=20000 + self._port_counter,
                created_at=datetime.now(timezone.utc),
                config=config,
            )
            self._instances[instance_id] = instance
            self._save_state()

        asyncio.create_task(self._provision(instance, config))
        return instance

    async def get_instance(self, instance_id: str) -> Optional[Instance]:
        return self._instances.get(instance_id)

    async def list_instances(self) -> list[Instance]:
        return list(self._instances.values())

    async def delete_instance(self, instance_id: str) -> bool:
        async with self._lock:
            if instance_id not in self._instances:
                return False
            self._instances.pop(instance_id)

        # Remove Docker container (by name, works even after restart)
        if self._docker:
            try:
                ctr = self._docker.containers.get(f"assistantx-{instance_id}")
                ctr.remove(force=True)
                logger.info("Removed container ombre-%s", instance_id)
            except docker.errors.NotFound:
                pass
            except Exception as exc:
                logger.warning("Remove container ombre-%s: %s", instance_id, exc)
        self._containers.pop(instance_id, None)

        # Remove profile dir if it exists
        profile_dir = pathlib.Path.home() / f".openclaw-assistantx-{instance_id}"
        if profile_dir.exists():
            import shutil
            try:
                shutil.rmtree(str(profile_dir))
            except Exception as exc:
                logger.warning("Remove profile dir %s: %s", profile_dir, exc)

        self._save_state()
        return True

    # ------------------------------------------------------------------
    # Provisioning
    # ------------------------------------------------------------------

    async def _provision(self, instance: Instance, config: InstanceConfig):
        if self._mode == "profile":
            await self._provision_profile(instance, config)
        else:
            await self._provision_docker(instance, config)

    async def _provision_docker(self, instance: Instance, config: InstanceConfig):
        loop = asyncio.get_event_loop()
        try:
            gemini_key = config.google_gemini_api_key or DEFAULT_GEMINI
            env = {"NO_UPDATE_CHECK": "1", "OPENCLAW_HIDE_BANNER": "1"}
            if gemini_key:
                env["GOOGLE_GENERATIVE_AI_API_KEY"] = gemini_key
                env["GEMINI_API_KEY"] = gemini_key
            if config.anthropic_api_key:
                env["ANTHROPIC_API_KEY"] = config.anthropic_api_key
            if config.openai_api_key:
                env["OPENAI_API_KEY"] = config.openai_api_key

            # Map the gateway port to a unique host port
            host_port = instance.proxy_port  # reuse the proxy_port slot
            ports = {"18789/tcp": host_port}

            container: Container = await loop.run_in_executor(
                None,
                lambda: self._docker.containers.run(
                    OPENCLAW_IMAGE,
                    command=["tail", "-f", "/dev/null"],
                    detach=True,
                    name=f"assistantx-{instance.id}",
                    environment=env,
                    ports=ports,
                    labels={
                        "assistantx.instance_id": instance.id,
                        "assistantx.managed": "true",
                    },
                    mem_limit="1536m",
                    memswap_limit="1536m",
                    cpu_quota=75000,
                    security_opt=["no-new-privileges"],
                    restart_policy={"Name": "unless-stopped"},
                ),
            )

            identity = await loop.run_in_executor(
                None, lambda: self._scaffold_container(container, gemini_key, config)
            )

            self._containers[instance.id] = container
            instance.container_id = container.id
            instance.gateway_port = host_port
            instance.gateway_token = identity["gateway_token"]
            instance.gateway_device_id = identity["device_id"]
            instance.gateway_device_pubkey = identity["pub_pem"]
            instance.gateway_device_privkey = identity["priv_pem"]

            # Start the OpenClaw gateway inside the container as a persistent process
            # (config already has gateway.auth.token baked in from _scaffold_container)
            logger.info("Starting OpenClaw gateway in container ombre-%s on host port %d ...", instance.id, host_port)
            await loop.run_in_executor(
                None,
                lambda: container.exec_run(
                    ["sh", "-c", "openclaw gateway run &>/tmp/gw.log &"],
                    detach=True,
                )
            )

            # Wait for gateway to be ready (up to 30s)
            gateway_ready = False
            for attempt in range(15):
                await asyncio.sleep(2)
                try:
                    import websockets
                    async with websockets.connect(
                        f"ws://127.0.0.1:{host_port}",
                        open_timeout=3,
                        close_timeout=2,
                    ) as ws:
                        gateway_ready = True
                        logger.info("Gateway ready for ombre-%s after %ds", instance.id, (attempt+1)*2)
                        break
                except Exception:
                    pass

            if not gateway_ready:
                logger.warning("Gateway not ready for ombre-%s after 30s — falling back to docker exec", instance.id)
                instance.gateway_port = None

            instance.status = InstanceStatus.RUNNING
            logger.info("Container instance %s (%s) RUNNING — ctr=%s gateway_port=%s",
                        instance.id, instance.name, container.short_id, instance.gateway_port)
            self._save_state()

        except Exception as exc:
            logger.error("Failed to provision container %s: %s", instance.id, exc)
            instance.status = InstanceStatus.ERROR
            self._save_state()

    def _scaffold_container(self, container: Container, gemini_key: str, config: InstanceConfig) -> dict:
        """Write openclaw.json + auth-profiles.json inside the container.
        Returns dict with gateway_token, device_id, pub_pem, priv_pem."""
        import secrets as _secrets
        gateway_token = _secrets.token_hex(24)  # 48-char hex token
        if gemini_key:
            model = "google/gemini-2.0-flash"
        elif config.anthropic_api_key:
            model = "anthropic/claude-3-5-haiku-20241022"
        else:
            model = "openai/gpt-4o-mini"

        oc_config = {
            "meta": {"lastTouchedVersion": "2026.2.25"},
            "wizard": {"lastRunAt": "2026-02-26T00:00:00.000Z"},  # skip setup wizard
            "agents": {"defaults": {"model": {"primary": model}}},
            "gateway": {
                "port": 18789,
                "mode": "local",
                "bind": "lan",
                "auth": {"mode": "token", "token": gateway_token},
                "controlUi": {"dangerouslyAllowHostHeaderOriginFallback": True},
            },
        }

        auth_profiles: dict = {
            "version": 1, "profiles": {}, "lastGood": {}, "usageStats": {}
        }
        if gemini_key:
            auth_profiles["profiles"]["google:default"] = {
                "type": "api_key", "provider": "google", "key": gemini_key
            }
            auth_profiles["lastGood"]["google"] = "google:default"
        if config.anthropic_api_key:
            auth_profiles["profiles"]["anthropic:default"] = {
                "type": "api_key", "provider": "anthropic", "key": config.anthropic_api_key
            }
            auth_profiles["lastGood"]["anthropic"] = "anthropic:default"
        if config.openai_api_key:
            auth_profiles["profiles"]["openai:default"] = {
                "type": "api_key", "provider": "openai", "key": config.openai_api_key
            }
            auth_profiles["lastGood"]["openai"] = "openai:default"

        auth_dir = "/root/.openclaw/agents/main/agent"
        container.exec_run(["mkdir", "-p", auth_dir])

        # Write config files using put_archive (reliable, no shell quoting issues)
        import io, tarfile
        def _write_file(path: str, data: bytes):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w') as tar:
                info = tarfile.TarInfo(name=os.path.basename(path))
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            buf.seek(0)
            container.put_archive(os.path.dirname(path), buf)

        _write_file("/root/.openclaw/openclaw.json", json.dumps(oc_config).encode())
        _write_file(f"{auth_dir}/auth-profiles.json", json.dumps(auth_profiles).encode())
        # Pre-seed identity/device.json — without this, openclaw hangs on first run
        # trying to generate device keys (Ed25519 keypair + device ID).
        import hashlib, time
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization

        pk = Ed25519PrivateKey.generate()
        pub = pk.public_key()
        pub_pem = pub.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        priv_pem = pk.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        device = {
            "version": 1,
            # OpenClaw derives deviceId as sha256(raw_public_key_bytes).hex
            "deviceId": hashlib.sha256(
                pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            ).hexdigest(),
            "publicKeyPem": pub_pem,
            "privateKeyPem": priv_pem,
            "createdAtMs": int(time.time() * 1000),
        }
        identity_dir = "/root/.openclaw/identity"
        container.exec_run(["mkdir", "-p", identity_dir])
        _write_file(f"{identity_dir}/device.json", json.dumps(device, indent=2).encode())

        # Pre-approve device pairing so the gateway accepts our WS connection immediately.
        # Without this, the first connection triggers a "pairing required" error.
        import secrets as _sec2, base64 as _b64
        raw_pub_bytes = pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        pub_key_b64 = _b64.urlsafe_b64encode(raw_pub_bytes).rstrip(b"=").decode()
        device_token = _sec2.token_urlsafe(32)
        scopes = ["operator.admin", "operator.read", "operator.write",
                  "operator.approvals", "operator.pairing"]
        now_ms = int(time.time() * 1000)
        paired_state = {
            device["deviceId"]: {
                "deviceId": device["deviceId"],
                "publicKey": pub_key_b64,
                "displayName": "AssistantX Proxy",
                "platform": "linux",
                "clientId": "gateway-client",
                "clientMode": "backend",
                "role": "operator",
                "roles": ["operator"],
                "scopes": scopes,
                "approvedScopes": scopes,
                "remoteIp": "172.17.0.1",
                "tokens": {
                    "operator": {
                        "token": device_token,
                        "role": "operator",
                        "scopes": scopes,
                        "createdAtMs": now_ms,
                        "rotatedAtMs": None,
                        "revokedAtMs": None,
                        "lastUsedAtMs": None,
                    }
                },
                "createdAtMs": now_ms,
                "approvedAtMs": now_ms,
            }
        }
        devices_dir = "/root/.openclaw/devices"
        container.exec_run(["mkdir", "-p", devices_dir])
        _write_file(f"{devices_dir}/paired.json", json.dumps(paired_state, indent=2).encode())
        _write_file(f"{devices_dir}/pending.json", json.dumps({}).encode())

        logger.info("Scaffolded openclaw config + identity in container %s", container.short_id)
        return {
            "gateway_token": gateway_token,
            "device_id": device["deviceId"],
            "pub_pem": pub_pem,
            "priv_pem": priv_pem,
        }

    # ------------------------------------------------------------------
    # Profile fallback
    # ------------------------------------------------------------------

    async def _provision_profile(self, instance: Instance, config: InstanceConfig):
        loop = asyncio.get_event_loop()
        try:
            gemini_key = config.google_gemini_api_key or DEFAULT_GEMINI
            profile_dir = pathlib.Path.home() / f".openclaw-assistantx-{instance.id}"
            auth_dir = profile_dir / "agents" / "main" / "agent"
            await loop.run_in_executor(None, lambda: auth_dir.mkdir(parents=True, exist_ok=True))

            oc_cfg = {
                "meta": {"lastTouchedVersion": "2026.2.25"},
                "wizard": {"lastRunAt": "2026-02-26T00:00:00.000Z"},
                "agents": {"defaults": {"model": {"primary": "google/gemini-2.0-flash"}}}
            }
            auth = {"version": 1, "profiles": {}, "lastGood": {}, "usageStats": {}}
            if gemini_key:
                auth["profiles"]["google:default"] = {
                    "type": "api_key", "provider": "google", "key": gemini_key
                }
                auth["lastGood"]["google"] = "google:default"

            (profile_dir / "openclaw.json").write_text(json.dumps(oc_cfg, indent=2))
            (auth_dir / "auth-profiles.json").write_text(json.dumps(auth, indent=2))

            instance.container_id = f"profile:ombre-{instance.id}"
            instance.status = InstanceStatus.RUNNING
            self._save_state()
            logger.info("Profile instance %s (%s) RUNNING", instance.id, instance.name)
        except Exception as exc:
            logger.error("Profile provision %s: %s", instance.id, exc)
            instance.status = InstanceStatus.ERROR
            self._save_state()

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def get_container_name(self, instance_id: str) -> Optional[str]:
        if instance_id not in self._instances:
            return None
        return f"assistantx-{instance_id}"

    def get_profile(self, instance_id: str) -> Optional[str]:
        if instance_id not in self._instances:
            return None
        return f"assistantx-{instance_id}"

    def get_gemini_key(self, instance_id: str) -> str:
        inst = self._instances.get(instance_id)
        if inst and inst.config.google_gemini_api_key:
            return inst.config.google_gemini_api_key
        return DEFAULT_GEMINI

    def get_container_host(self, instance_id: str) -> Optional[str]:
        """Compat shim used by proxy router — returns non-None if instance exists."""
        return "docker" if instance_id in self._instances else None

    @property
    def mode(self) -> str:
        return self._mode
