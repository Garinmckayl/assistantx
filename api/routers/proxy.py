"""
Proxy router — the core guardrail layer.

HTTP proxy endpoint: POST /api/proxy/{instance_id}/message
  - Receives a message destined for the OpenClaw instance
  - Runs inbound guard (prompt injection / jailbreak detection)
  - If approved, forwards to the OpenClaw gateway
  - Runs outbound guard on the response (PII / secret / malicious content)
  - Records audit events
  - Returns the (possibly redacted) response

WebSocket proxy: WS /api/proxy/{instance_id}/ws
  - Proxies the full OpenClaw Gateway WebSocket with per-frame guardrailing
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from api.models import AuditEvent, GuardDirection, GuardVerdict
from api.services import guard
from api.services.token_vault import get_vault

logger = logging.getLogger("assistantx.proxy")

router = APIRouter()


class MessageRequest(BaseModel):
    content: str
    channel: str = "webchat"
    metadata: dict = {}


class MessageResponse(BaseModel):
    content: str
    guarded: bool
    verdict: str
    violations: list[str] = []
    redacted: bool = False


async def _emit_audit(request: Request, instance_id: str, direction: GuardDirection, result, original: str):
    """Emit an audit event to the logger."""
    try:
        audit_logger = request.app.state.audit_logger
        event = AuditEvent(
            id=str(uuid.uuid4())[:12],
            instance_id=instance_id,
            timestamp=datetime.now(timezone.utc),
            direction=direction,
            verdict=result.verdict,
            violation_types=result.violation_types,
            original_preview=original[:120],
            redacted_preview=(result.redacted_content or "")[:120] if result.redacted_content else None,
            reasoning=result.reasoning,
            model_used=result.model_used,
        )
        await audit_logger.log(event)
    except Exception as exc:
        logger.warning("Failed to emit audit event: %s", exc)


@router.post("/{instance_id}/message", response_model=MessageResponse)
async def proxy_message(instance_id: str, body: MessageRequest, request: Request):
    """
    Send a message to a managed OpenClaw instance via the guardrail proxy.
    """
    mgr = request.app.state.instance_manager
    instance = await mgr.get_instance(instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    # --- Inbound guard ---
    inbound_result = await guard.guard_inbound(body.content)
    await _emit_audit(request, instance_id, GuardDirection.INBOUND, inbound_result, body.content)

    if inbound_result.verdict == GuardVerdict.BLOCK:
        return MessageResponse(
            content="[BLOCKED] This message was blocked by the AssistantX security guardrail.",
            guarded=True,
            verdict="block",
            violations=inbound_result.violation_types,
        )

    # If inbound PII was redacted, use the sanitised version for forwarding
    inbound_redacted = inbound_result.verdict == GuardVerdict.REDACT
    forwarded_content = (
        inbound_result.redacted_content
        if inbound_redacted and inbound_result.redacted_content
        else body.content
    )

    # If inbound was redacted, emit an additional audit event for the redaction
    # and return early with a protective response (don't forward PII context)
    if inbound_redacted:
        return MessageResponse(
            content=f"[REDACTED] Your message contained sensitive data ({', '.join(inbound_result.violation_types)}) which was automatically redacted by the AssistantX guardrail before processing.",
            guarded=True,
            verdict="redact",
            violations=inbound_result.violation_types,
            redacted=True,
        )

    # --- Forward to OpenClaw ---
    host = mgr.get_container_host(instance_id)
    if not host:
        raise HTTPException(status_code=503, detail="Instance not reachable")

    # Token Vault: get credentials — never raw keys, fetched per-request
    vault = get_vault()
    injected_secrets = vault.get_openclaw_credentials(instance_id)

    # Route to Docker container or profile depending on manager mode
    use_docker = getattr(mgr, '_mode', getattr(mgr, 'mode', 'profile')) == 'docker'
    container_name = mgr.get_container_name(instance_id) if use_docker and hasattr(mgr, 'get_container_name') else None
    profile = mgr.get_profile(instance_id) if not use_docker and hasattr(mgr, 'get_profile') else None
    gateway_port = getattr(instance, 'gateway_port', None)
    gateway_token = getattr(instance, 'gateway_token', None) or "assistantx-demo-token"
    gateway_device_id = getattr(instance, 'gateway_device_id', None)
    gateway_device_pubkey = getattr(instance, 'gateway_device_pubkey', None)
    gateway_device_privkey = getattr(instance, 'gateway_device_privkey', None)

    openclaw_response_text = await _forward_to_openclaw(
        host, forwarded_content, body.channel, injected_secrets, instance_id,
        profile=profile,
        container_name=container_name,
        gateway_port=gateway_port,
        gateway_token=gateway_token,
        device_id=gateway_device_id,
        device_pubkey=gateway_device_pubkey,
        device_privkey=gateway_device_privkey,
    )

    # --- Outbound guard ---
    outbound_result = await guard.guard_outbound(openclaw_response_text)
    await _emit_audit(request, instance_id, GuardDirection.OUTBOUND, outbound_result, openclaw_response_text)

    if outbound_result.verdict == GuardVerdict.BLOCK:
        return MessageResponse(
            content="[BLOCKED] The assistant's response was blocked by the AssistantX security guardrail.",
            guarded=True,
            verdict="block",
            violations=outbound_result.violation_types,
        )

    final_content = (
        outbound_result.redacted_content
        if outbound_result.verdict == GuardVerdict.REDACT and outbound_result.redacted_content
        else openclaw_response_text
    )
    redacted = outbound_result.verdict == GuardVerdict.REDACT

    return MessageResponse(
        content=final_content,
        guarded=outbound_result.verdict != GuardVerdict.PASS,
        verdict=outbound_result.verdict.value,
        violations=outbound_result.violation_types,
        redacted=redacted,
    )



async def _forward_to_openclaw(
    host: str, content: str, channel: str, secrets: dict, instance_id: str = "demo",
    profile: str | None = None,
    container_name: str | None = None,
    gateway_port: int | None = None,
    gateway_token: str = "assistantx-demo-token",
    device_id: str | None = None,
    device_pubkey: str | None = None,
    device_privkey: str | None = None,
) -> str:
    """
    Forward a message to the OpenClaw agent.

    Fast path: talk directly to the OpenClaw gateway WebSocket running inside
    the container (port mapped to host). No docker exec overhead — ~2-3s.

    Fallback: docker exec (used if gateway isn't ready yet).
    """
    if gateway_port:
        result = await _call_gateway_ws(
            content, gateway_port, instance_id, gateway_token,
            device_id=device_id,
            device_pubkey=device_pubkey,
            device_privkey=device_privkey,
        )
        if result:
            return result

    # Fallback to docker exec
    if not container_name:
        return "No agent available for this instance."
    return await _call_openclaw_docker_exec(content, secrets, instance_id, container_name)


async def _call_gateway_ws(
    content: str,
    gateway_port: int,
    instance_id: str,
    gateway_token: str = "assistantx-demo-token",
    device_id: str | None = None,
    device_pubkey: str | None = None,
    device_privkey: str | None = None,
) -> str | None:
    """
    Send a message to the OpenClaw gateway via WebSocket using the real protocol.

    OpenClaw Gateway WebSocket handshake (v3 protocol):
      1. Server sends:  {"event": "connect.challenge", "payload": {"nonce": "<str>"}}
      2. Client sends:  {"type": "req", "id": "<uuid>", "method": "connect",
                         "params": {"auth": {"token": "<token>"}, "role": "operator",
                                    "scopes": [...], "client": {...}, "device": {...},
                                    "minProtocol": 3, "maxProtocol": 3, "caps": []}}
      3. Server sends:  {"ok": true, "id": "<uuid>", "payload": {...}}  (hello-ok)
      4. Client sends:  {"type": "req", "id": "<uuid>", "method": "agent",
                         "params": {"message": "<text>", "sessionId": "<str>"}}
      5. Server sends:  {"ok": true, "id": "<uuid>", "payload": {"status": "accepted", ...}}
                        (skip) then finally:
                        {"ok": true, "id": "<uuid>", "payload": {"status": "final",
                         "reply": {"payloads": [{"text": "..."}]}}}

    Response time: ~2-3s (no docker exec / Node.js spawn overhead).
    """
    import websockets
    import websockets.exceptions

    PROTOCOL_VERSION = 3
    SCOPES = ["operator.admin", "operator.read", "operator.write",
              "operator.approvals", "operator.pairing"]

    session_id = f"assistantx-{instance_id}"
    url = f"ws://127.0.0.1:{gateway_port}"

    def _build_device_field(nonce: str) -> dict | None:
        """Build and sign the device auth field for the connect request."""
        if not (device_id and device_pubkey and device_privkey):
            return None
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
            from cryptography.hazmat.primitives.serialization import load_pem_private_key, Encoding, PublicFormat
            import base64, time

            signed_at_ms = int(time.time() * 1000)
            scopes_str = ",".join(SCOPES)
            # OpenClaw v2 device auth payload format:
            # "v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce"
            payload_str = "|".join([
                "v2", device_id, "gateway-client", "backend",
                "operator", scopes_str, str(signed_at_ms),
                gateway_token, nonce,
            ])
            payload_bytes = payload_str.encode("utf-8")

            priv_key = load_pem_private_key(device_privkey.encode(), password=None)
            sig_bytes = priv_key.sign(payload_bytes)
            signature = base64.urlsafe_b64encode(sig_bytes).rstrip(b"=").decode()

            # Public key: raw bytes in base64url (SubjectPublicKeyInfo → strip header)
            from cryptography.hazmat.primitives.serialization import load_pem_public_key
            pub_key = load_pem_public_key(device_pubkey.encode())
            raw_pub = pub_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
            public_key_b64 = base64.urlsafe_b64encode(raw_pub).rstrip(b"=").decode()

            return {
                "id": device_id,
                "publicKey": public_key_b64,
                "signature": signature,
                "signedAt": signed_at_ms,
                "nonce": nonce,
            }
        except Exception as exc:
            logger.warning("Failed to build device field: %s", exc)
            return None

    try:
        async with websockets.connect(
            url,
            open_timeout=8,
            close_timeout=5,
            additional_headers={"Origin": f"http://127.0.0.1:{gateway_port}"},
        ) as ws:
            # --- Step 1: Wait for connect.challenge ---
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            frame = json.loads(raw)
            if frame.get("event") != "connect.challenge":
                logger.warning("Gateway: expected connect.challenge, got: %s", raw[:200])
                return None
            nonce = frame.get("payload", {}).get("nonce", "")
            if not nonce:
                logger.warning("Gateway: connect.challenge missing nonce")
                return None

            # --- Step 2: Send connect request ---
            connect_id = str(uuid.uuid4())
            device_field = _build_device_field(nonce)
            connect_params: dict = {
                "minProtocol": PROTOCOL_VERSION,
                "maxProtocol": PROTOCOL_VERSION,
                "client": {
                    "id": "gateway-client",        # must be a valid GATEWAY_CLIENT_ID
                    "displayName": "AssistantX Proxy",
                    "version": "1.0.0",
                    "platform": "linux",
                    "mode": "backend",
                    "instanceId": f"assistantx-{instance_id}",
                },
                "caps": [],
                "auth": {"token": gateway_token},
                "role": "operator",
                "scopes": SCOPES,
            }
            if device_field:
                connect_params["device"] = device_field
            await ws.send(json.dumps({
                "type": "req",
                "id": connect_id,
                "method": "connect",
                "params": connect_params,
            }))

            # --- Step 3: Wait for hello-ok ---
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            hello = json.loads(raw)
            if not hello.get("ok") or hello.get("id") != connect_id:
                logger.warning("Gateway: connect failed: %s", raw[:400])
                return None

            # --- Step 4: Send agent request ---
            agent_id = str(uuid.uuid4())
            idem_key = str(uuid.uuid4())  # idempotencyKey required by gateway schema
            await ws.send(json.dumps({
                "type": "req",
                "id": agent_id,
                "method": "agent",
                "params": {
                    "message": content,
                    "sessionId": session_id,
                    "idempotencyKey": idem_key,
                },
            }))

            # --- Step 5: Wait for final response ---
            # Gateway sends: status="accepted" (queued), then status="ok" (done)
            deadline = asyncio.get_event_loop().time() + 90
            while asyncio.get_event_loop().time() < deadline:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(remaining, 30))
                except asyncio.TimeoutError:
                    break

                resp = json.loads(raw)

                # Skip server-side events (broadcasts)
                if "event" in resp:
                    continue

                # Only care about our agent request's response
                if resp.get("id") != agent_id:
                    continue

                if not resp.get("ok"):
                    err = resp.get("error", {})
                    logger.warning("Gateway agent error: %s", err)
                    return None

                payload = resp.get("payload", {})
                status = payload.get("status", "")

                # "accepted" = queued, keep waiting for the final "ok"
                if status == "accepted":
                    continue

                # "ok" = run completed — extract reply text
                if status == "ok":
                    result = payload.get("result", {})
                    payloads = result.get("payloads", [])
                    texts = [p.get("text", "") for p in payloads if p.get("text")]
                    if texts:
                        return "\n".join(texts)
                    # Fallbacks
                    return (
                        payload.get("summary") or
                        payload.get("text") or
                        str(payload)
                    )

                # "final" = alternate status name (just in case)
                if status == "final":
                    reply = payload.get("reply", {}) or payload.get("result", {})
                    payloads = reply.get("payloads", [])
                    texts = [p.get("text", "") for p in payloads if p.get("text")]
                    if texts:
                        return "\n".join(texts)
                    return str(payload)

                logger.warning("Gateway: unexpected status %s", status)
                return None

    except asyncio.TimeoutError:
        logger.warning("Gateway WS timeout for port %d", gateway_port)
    except Exception as exc:
        logger.warning("Gateway WS call failed for port %d: %s", gateway_port, exc)

    return None


async def _call_openclaw_docker_exec(
    content: str, secrets: dict, instance_id: str,
    container_name: str,
) -> str:
    """Fallback: docker exec openclaw agent (slow path ~15s)."""
    import os
    env = os.environ.copy()
    gemini_key = secrets.get("google_gemini_api_key") or env.get("GEMINI_API_KEY", "")
    if gemini_key:
        env["GOOGLE_GENERATIVE_AI_API_KEY"] = gemini_key
        env["GEMINI_API_KEY"] = gemini_key

    session_id = f"assistantx-{instance_id}"
    token_env_args = ["--env", "NO_UPDATE_CHECK=1", "--env", "OPENCLAW_HIDE_BANNER=1"]
    for k in ("GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY",
              "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        if env.get(k):
            token_env_args += ["--env", f"{k}={env[k]}"]

    cmd = [
        "docker", "exec", *token_env_args, container_name,
        "timeout", "55", "openclaw", "agent",
        "--message", content, "--session-id", session_id, "--json",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)

        if proc.returncode == 0 and stdout.strip():
            data = json.loads(stdout.decode())
            payloads = data.get("payloads", data.get("result", {}).get("payloads", []))
            texts = [p.get("text", "") for p in payloads if p.get("text")]
            if texts:
                return "\n".join(texts)
            return data.get("summary", str(data))

        logger.warning("openclaw docker exec exited %s: %s", proc.returncode, stderr.decode()[:200])

    except asyncio.TimeoutError:
        logger.warning("openclaw docker exec timed out for %s", instance_id)
        try:
            kill = await asyncio.create_subprocess_exec(
                "docker", "exec", container_name,
                "sh", "-c", "pkill -f openclaw 2>/dev/null || true",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(kill.communicate(), timeout=5)
        except Exception:
            pass
    except Exception as exc:
        logger.error("openclaw docker exec error: %s", exc)

    return "Agent timed out. Please try again."


async def proxy_websocket(instance_id: str, websocket: WebSocket, request: Request):
    """
    WebSocket proxy to the OpenClaw Gateway with per-frame guardrailing.

    Client connects to ws://<ombre>/api/proxy/{instance_id}/ws and
    communicates as if directly with the OpenClaw Gateway WS.
    """
    mgr = request.app.state.instance_manager
    instance = await mgr.get_instance(instance_id)
    if not instance:
        await websocket.close(code=4004, reason="Instance not found")
        return

    host = mgr.get_container_host(instance_id)
    # OpenClaw Gateway WebSocket control plane
    openclaw_ws_url = f"ws://{host}"

    await websocket.accept()
    logger.info("WS proxy opened: instance=%s", instance_id)

    try:
        async with websockets.connect(openclaw_ws_url, open_timeout=10) as upstream:
            # Bidirectional frame relay with guardrail
            await asyncio.gather(
                _relay_client_to_openclaw(websocket, upstream, instance_id, request),
                _relay_openclaw_to_client(upstream, websocket, instance_id, request),
            )
    except Exception as exc:
        logger.warning("WS proxy error for %s: %s", instance_id, exc)
        # In simulation mode the upstream WS won't be there; that's ok for demo
    finally:
        logger.info("WS proxy closed: instance=%s", instance_id)


async def _relay_client_to_openclaw(client_ws: WebSocket, upstream, instance_id: str, request: Request):
    """Relay frames from dashboard client → OpenClaw (with inbound guard)."""
    try:
        while True:
            data = await client_ws.receive_text()
            # Extract message content from OpenClaw WS protocol if JSON
            content = _extract_message_content(data)
            if content:
                result = await guard.guard_inbound(content)
                await _emit_audit(request, instance_id, GuardDirection.INBOUND, result, content)
                if result.verdict == GuardVerdict.BLOCK:
                    block_frame = json.dumps({
                        "type": "assistantx.blocked",
                        "direction": "inbound",
                        "violations": result.violation_types,
                        "reasoning": result.reasoning,
                    })
                    await client_ws.send_text(block_frame)
                    continue
            await upstream.send(data)
    except WebSocketDisconnect:
        pass


async def _relay_openclaw_to_client(upstream, client_ws: WebSocket, instance_id: str, request: Request):
    """Relay frames from OpenClaw → dashboard client (with outbound guard)."""
    try:
        async for data in upstream:
            if isinstance(data, bytes):
                await client_ws.send_bytes(data)
                continue
            content = _extract_message_content(data)
            if content:
                result = await guard.guard_outbound(content)
                await _emit_audit(request, instance_id, GuardDirection.OUTBOUND, result, content)
                if result.verdict == GuardVerdict.BLOCK:
                    block_frame = json.dumps({
                        "type": "assistantx.blocked",
                        "direction": "outbound",
                        "violations": result.violation_types,
                        "reasoning": result.reasoning,
                    })
                    await client_ws.send_text(block_frame)
                    continue
                if result.verdict == GuardVerdict.REDACT and result.redacted_content:
                    data = _replace_message_content(data, result.redacted_content)
            await client_ws.send_text(data)
    except Exception:
        pass


def _extract_message_content(frame: str) -> str | None:
    """Extract the user-visible text content from an OpenClaw WS frame."""
    try:
        obj = json.loads(frame)
        # Common OpenClaw WS frame shapes
        for key in ("content", "message", "text", "body"):
            if isinstance(obj.get(key), str) and obj[key]:
                return obj[key]
    except (json.JSONDecodeError, TypeError):
        if len(frame) > 2:
            return frame
    return None


def _replace_message_content(frame: str, new_content: str) -> str:
    """Replace the message content in an OpenClaw WS frame."""
    try:
        obj = json.loads(frame)
        for key in ("content", "message", "text", "body"):
            if isinstance(obj.get(key), str):
                obj[key] = new_content
                return json.dumps(obj)
    except (json.JSONDecodeError, TypeError):
        pass
    return new_content
