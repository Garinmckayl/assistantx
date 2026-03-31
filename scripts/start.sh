#!/bin/bash
# AssistantX quickstart — run on your DO Droplet
# Usage: bash scripts/start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT"

# ── Check .env ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo ""
  echo "  No .env file found. Creating from .env.example..."
  cp .env.example .env
  echo ""
  echo "  REQUIRED: Open .env and add your DO_GRADIENT_API_KEY"
  echo "  (get it from: cloud.digitalocean.com/gradient/settings)"
  echo ""
  echo "  Then re-run this script."
  echo ""
  exit 1
fi

source .env

if [ -z "$DO_GRADIENT_API_KEY" ]; then
  echo ""
  echo "  WARNING: DO_GRADIENT_API_KEY is not set in .env"
  echo "  The guardrail will use regex + @agntor/sdk only (no LLM deep scan)"
  echo "  Get your key from: cloud.digitalocean.com/gradient/settings"
  echo ""
fi

# ── Build dashboard if needed ────────────────────────────────────────────────
if [ ! -d "$ROOT/dashboard/dist" ]; then
  echo "Building dashboard..."
  cd "$ROOT/dashboard"
  npm install --silent
  npm run build
  cd "$ROOT"
  echo "Dashboard built."
fi

# ── Install Python deps if needed ────────────────────────────────────────────
python3 -c "import fastapi" 2>/dev/null || {
  echo "Installing Python dependencies..."
  pip3 install fastapi "uvicorn[standard]" httpx websockets docker boto3 pydantic python-dotenv --break-system-packages -q
}

# ── Start ────────────────────────────────────────────────────────────────────
echo ""
echo "  ombre is starting..."
echo ""
echo "  Dashboard: http://$(hostname -I | awk '{print $1}'):8000"
echo "  API docs:  http://$(hostname -I | awk '{print $1}'):8000/docs"
echo ""
echo "  What to do next:"
echo "   1. Open the dashboard URL above"
echo "   2. Click Connect next to Anthropic and paste your sk-ant-... key"
echo "   3. Go to Dashboard and test the guardrail"
echo ""

python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8000
