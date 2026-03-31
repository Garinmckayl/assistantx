"""
AssistantX — The Dead-Man Switch.

A hardened proxy that sits in front of OpenClaw with Auth0 Token Vault
at its core. The agent acts on your behalf. You never hold the credentials.
You cannot be coerced into surrendering what you do not have.

Built on AssistantX (DigitalOcean Hackathon) — upgraded with Auth0 Token Vault
for the Authorized to Act Hackathon.
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

from api.routers import instances, proxy, events, health, onboard, channels, workflows
from api.routers.checkin import router as deadman_router
from api.routers.consent import router as consent_router
from api.services.instance_manager import InstanceManager
from api.services.audit_log import AuditLogger
from api.services.token_vault import get_vault

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("assistantx")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("AssistantX starting up — Dead-Man Switch armed...")
    # Initialise singletons
    app.state.instance_manager = InstanceManager()
    app.state.audit_logger = AuditLogger()
    app.state.token_vault = get_vault()
    await app.state.instance_manager.startup()

    # Seed assistantx-default ONLY on first ever run (no instances on disk yet)
    import os
    from api.models import InstanceConfig
    existing = await app.state.instance_manager.list_instances()
    if not existing:
        seed_key = os.getenv("GEMINI_API_KEY", "")
        try:
            await app.state.instance_manager.create_instance(
                InstanceConfig(name="assistantx-default", google_gemini_api_key=seed_key)
            )
            logger.info("First-run seed: created assistantx-default instance")
        except Exception as exc:
            logger.warning("Could not seed assistantx-default instance: %s", exc)
    else:
        logger.info("Restored %d existing instances from disk", len(existing))

    yield
    logger.info("AssistantX shutting down...")
    await app.state.instance_manager.shutdown()


app = FastAPI(
    title="AssistantX",
    description="Dead-Man Switch — secured by Auth0 Token Vault. The agent acts. You stay in control.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Authentication middleware — protects all /api/ routes except health & login
# ---------------------------------------------------------------------------
ADMIN_TOKEN = os.getenv("ASSISTANTX_ADMIN_TOKEN", "")
ADMIN_PASSWORD = os.getenv("ASSISTANTX_ADMIN_PASSWORD", "assistantx-demo-2026")

# Public routes that don't require auth
_PUBLIC_PATHS = {"/api/health", "/api/auth/login"}
# Prefix paths that are public
_PUBLIC_PREFIXES = ("/api/events/", "/api/deadman/", "/api/consent/")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path

    # Skip auth for non-API routes (dashboard static files) and public paths
    if not path.startswith("/api/") or path in _PUBLIC_PATHS:
        return await call_next(request)

    # SSE and event stream paths are public (read-only audit data, UI is gated)
    if any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return await call_next(request)

    # If no admin token is configured, auth is disabled (dev mode)
    if not ADMIN_TOKEN:
        return await call_next(request)

    # Check bearer token
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        if token and token == ADMIN_TOKEN:
            return await call_next(request)

    return JSONResponse(
        status_code=401,
        content={"error": "unauthorized", "message": "Valid authentication required"},
    )


@app.post("/api/auth/login")
async def login(request: Request):
    """Authenticate with password, receive a session token."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "invalid request"})

    password = body.get("password", "")
    if password == ADMIN_PASSWORD:
        return {"token": ADMIN_TOKEN, "status": "ok"}

    return JSONResponse(
        status_code=401,
        content={"error": "invalid password"},
    )

# API routers
app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(instances.router, prefix="/api/instances", tags=["instances"])
app.include_router(proxy.router, prefix="/api/proxy", tags=["proxy"])
app.include_router(events.router, prefix="/api/events", tags=["events"])
app.include_router(onboard.router, prefix="/api", tags=["onboard"])
app.include_router(channels.router, prefix="/api/instances", tags=["channels"])
app.include_router(workflows.router, prefix="/api", tags=["templates"])
app.include_router(workflows.router, prefix="/api/instances", tags=["workflows"])
# AssistantX — Dead-Man Switch + Token Vault
app.include_router(deadman_router, prefix="/api/deadman", tags=["dead-man-switch"])
app.include_router(consent_router, prefix="/api/consent", tags=["consent"])

# Serve the React dashboard from /dashboard/dist
try:
    app.mount("/", StaticFiles(directory="dashboard/dist", html=True), name="dashboard")
except RuntimeError:
    # Dashboard not built yet — serve a placeholder
    @app.get("/")
    async def root():
        return {"message": "AssistantX API — dashboard not built. Run: cd dashboard && npm run build"}


if __name__ == "__main__":
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
