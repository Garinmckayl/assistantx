"""
Onboarding assistant — Gemini-powered chat that helps users set up AssistantX.
"""

import json
import logging
import os

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel

logger = logging.getLogger("assistantx.onboard")

router = APIRouter()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"

SYSTEM_PROMPT = """\
You are the AssistantX onboarding assistant — a friendly, concise guide that helps new users \
set up their AssistantX deployment.  AssistantX is a mini-PaaS that runs managed, isolated OpenClaw \
AI agent instances on DigitalOcean, with every message passing through a 3-layer security \
guardrail (regex → semantic scan → DO Gradient LLM).

Your job during onboarding:
1. Welcome the user warmly (one short sentence).
2. Answer any questions about AssistantX, OpenClaw, guardrails, or integrations.
3. Help them choose a name for their first agent instance.
4. Explain how to get a Gemini API key if they need one (go to ai.google.dev).
5. Once they have connected their key, congratulate them and tell them to go to the Instances tab.

Keep responses SHORT (2-3 sentences max). Use markdown bold for emphasis. Be enthusiastic but professional.
Do NOT use emojis excessively — one per message at most.

Key facts about AssistantX:
- Each instance = isolated Docker container with its own OpenClaw profile
- Guardrail layers: Layer 1 (regex patterns, <1ms), Layer 2 (@agntor/sdk semantic), Layer 3 (DO Gradient Llama 3.3 70B)
- Supported integrations: Telegram, WhatsApp, Discord, Slack, GitHub, email, and 40+ more via OpenClaw skills
- The guardrail scans BOTH directions — inbound (user→agent) and outbound (agent→user)
- Audit log streams every decision in real-time via SSE
- Built natively on DigitalOcean (Droplet + Gradient AI + Spaces)
"""


class OnboardMessage(BaseModel):
    messages: list[dict]  # [{role: "user"|"assistant", content: "..."}]


@router.post("/onboard/chat")
async def onboard_chat(req: OnboardMessage):
    """Send a message to the onboarding assistant (Gemini)."""
    key = GEMINI_API_KEY
    if not key:
        return {"content": "Onboarding assistant unavailable — no Gemini API key configured on the server."}

    # Build Gemini request
    contents = [{"role": "user", "parts": [{"text": SYSTEM_PROMPT}]}]
    contents.append({"role": "model", "parts": [{"text": "Understood. I'm the AssistantX onboarding assistant. I'll help users set up their deployment."}]})

    for m in req.messages:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    payload = {
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 256,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{GEMINI_URL}?key={key}",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return {"content": text}
    except Exception as exc:
        logger.error("Onboard chat error: %s", exc)
        return {"content": "Sorry, I couldn't connect to the AI. Please try again in a moment."}
