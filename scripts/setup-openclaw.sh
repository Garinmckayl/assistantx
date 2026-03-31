#!/bin/bash
# Run this ONCE to set up OpenClaw on the host for demo mode.
# OpenClaw will run as a systemd service alongside AssistantX.

set -e

GEMINI_KEY=${1:-$GEMINI_API_KEY}

if [ -z "$GEMINI_KEY" ]; then
  echo "Usage: bash setup-openclaw.sh YOUR_GEMINI_API_KEY"
  exit 1
fi

# Write OpenClaw config (model = Gemini, no secrets stored here — injected by AssistantX proxy)
mkdir -p /root/.openclaw
cat > /root/.openclaw/openclaw.json << EOF
{
  "agent": {
    "model": "google/gemini-2.0-flash"
  },
  "gateway": {
    "bind": "all",
    "port": 18789,
    "auth": { "mode": "none" }
  }
}
EOF

# Write env file for OpenClaw systemd service
cat > /root/.openclaw/env << EOF
GEMINI_API_KEY=$GEMINI_KEY
GOOGLE_GENERATIVE_AI_API_KEY=$GEMINI_KEY
EOF

# Create systemd service for OpenClaw
cat > /etc/systemd/system/openclaw.service << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
EnvironmentFile=/root/.openclaw/env
ExecStart=/usr/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable openclaw
systemctl restart openclaw
sleep 3
systemctl status openclaw --no-pager | head -10

echo ""
echo "OpenClaw is running on port 18789"
echo "Ombre will proxy it at http://45.55.133.138:8000"
