"""Health check router."""

import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from api.services.token_vault import get_vault

router = APIRouter()


@router.get("/health")
async def health():
    vault = get_vault()
    return {
        "status": "ok",
        "service": "assistantx",
        "version": "1.0.0",
        "token_vault_mode": "auth0" if (os.getenv("AUTH0_DOMAIN") and not vault.demo_mode) else "demo",
        "guardrails": "active",
    }
