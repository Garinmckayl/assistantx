# AssistantX

> *She couldn't give them the passwords. She never had them. The vault did. And the vault was already done.*

**AssistantX** is a zero-config secure AI assistant for journalists, activists, and lawyers under persecution. It runs OpenClaw in total credential isolation, secured by **Auth0 Token Vault**.

The agent acts on your behalf. You never hold the credentials. You cannot be coerced into surrendering what you do not have.

**Live demo:** [assistantx.arcumet.com](https://assistantx.arcumet.com/) — password: `assistantx-demo-2026`

Built for the [Authorized to Act Hackathon](https://authorizedtoact.devpost.com/).

---

## The Problem

Ethiopia ranks **145th out of 180 countries** for press freedom.

A journalist here runs an AI assistant. It reads their notes, their sources, their drafts, their secure communications. It's the most powerful tool they have — and the most dangerous thing they own.

If they're arrested, their phone is taken. Their accounts are accessed. The credentials their agent holds become evidence, or leverage, or a death sentence.

There are an estimated **3.8 million AI agent deployments** active today. Every one of them holds credentials. The average cost of a credential breach is **$4.5M** (IBM, 2024).

**AssistantX eliminates that attack surface entirely.**

---

## Architecture

```
User message
      │
      ▼
┌──────────────────────────────────────────┐
│             AssistantX Proxy             │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │  Guard Layer 1                   │    │  ← @agntor/sdk heuristics (~5ms)
│  └──────────────┬─────────────────  ┘    │
│                 │                        │
│  ┌──────────────▼─────────────────  ┐    │
│  │  Guard Layer 2                   │    │  ← LLM deep classifier (~200ms)
│  └──────────────┬─────────────────  ┘    │
│                 │                        │
│  ┌──────────────▼─────────────────  ┐    │
│  │  Auth0 Token Vault               │    │  ← Scoped token per action
│  │                                  │    │    Raw credentials NEVER present
│  │  Isolation Forest (anomaly)      │    │  ← Vault access behavioral sensor
│  │                                  │    │
│  │  Dead-Man Switch Monitor         │    │  ← 60s background tick
│  └──────────────┬─────────────────  ┘    │
└─────────────────┼────────────────────────┘
                  │
                  ▼
      OpenClaw (isolated Docker container)
          — no credentials stored
          — no raw keys ever present
                  │
                  ▼
         Third-party API call
       (scoped token, not master key)
```

---

## Four Layers of Protection

**Layer 1 — Isolated execution environment**

Every OpenClaw instance runs in its own Docker container. No API keys. No credential files. No environment variables with secrets. If the container is compromised, there is nothing to exfiltrate.

**Layer 2 — Auth0 Token Vault**

When the agent needs to call an external API, AssistantX calls Token Vault — not a config file. A scoped, time-limited access token is issued for the specific service and scope required. The token exists in memory for the duration of one request, then is gone.

**Layer 3 — Vault Behavioral Anomaly Detection**

Every token request is a behavioral event. An Isolation Forest (`sklearn`, `n_estimators=100`, `contamination=0.05`) trains on the stream of vault access events per instance. Features: hour of day, day of week, connection risk, scope risk, hours since last access, request rate. Anomalies are flagged before the token is issued.

This is only possible because Token Vault exists. Raw API keys have no audit trail. The vault is a behavioral sensor.

**Layer 4 — The Dead-Man Switch**

The user sets a check-in schedule. As long as pulses arrive, the agent operates normally. If they stop:

1. Token Vault issues a **Google Drive token** (scope: `drive.file`, TTL: 60min)
2. Encrypted files distributed to pre-configured secure mirrors
3. Token Vault issues a **Gmail token** (scope: `gmail.send`, TTL: 30min)
4. Trusted contacts notified
5. `revoke_all()` — vault emptied, scorched earth

Re-arming requires step-up authorization from a trusted contact. You cannot be forced to cancel it.

**You cannot surrender credentials you do not have.**

---

## API

### Dead-Man Switch

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/deadman/{id}/setup` | Configure contacts, destinations, schedule |
| `POST` | `/api/deadman/{id}/checkin` | Send check-in pulse |
| `GET`  | `/api/deadman/{id}/status` | State, timing, distribution log |
| `POST` | `/api/deadman/{id}/rearm` | Re-arm (trusted contact step-up) |
| `POST` | `/api/deadman/{id}/simulate` | Demo: simulate trigger |

### Token Vault & Consent

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/consent/connections` | All connected services + status |
| `POST`   | `/api/consent/authorize` | Connect a service via Token Vault OAuth |
| `POST`   | `/api/consent/revoke` | Revoke a connected service |
| `GET`    | `/api/consent/{id}` | Instance-level consent view |
| `GET`    | `/api/consent/{id}/anomalies` | Anomaly detector status + recent flags |
| `POST`   | `/api/consent/{id}/revoke-all` | Revoke everything |

---

## Quickstart

```bash
git clone https://github.com/Garinmckayl/assistantx
cd assistantx && cp .env.example .env
```

```env
# Auth0 Token Vault (required for production, optional for demo)
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret

# Demo mode works without Auth0 credentials
ASSISTANTX_ADMIN_PASSWORD=your-password
```

```bash
# With Docker (recommended)
docker compose up

# Or directly
pip install fastapi uvicorn httpx websockets docker boto3 pydantic scikit-learn numpy python-dotenv
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000
```

**Configure the Dead-Man Switch:**

```bash
curl -X POST http://localhost:8000/api/deadman/my-instance/setup \
  -H "Content-Type: application/json" \
  -d '{
    "checkin_interval_hours": 24,
    "grace_period_hours": 2,
    "checkin_word": "alive",
    "trusted_contacts": [
      {"name": "Sarah", "email": "sarah@proton.me", "can_rearm": true}
    ],
    "secure_destinations": [
      {"name": "Drive Mirror", "type": "google_drive", "url": ""}
    ]
  }'
```

**Send a check-in:**

```bash
curl -X POST http://localhost:8000/api/deadman/my-instance/checkin \
  -d '{"word": "alive"}'
```

**Demo — simulate a trigger:**

```bash
curl -X POST http://localhost:8000/api/deadman/my-instance/simulate \
  -d '{"scenario": "trigger"}'
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| **Identity & tokens** | Auth0 Token Vault |
| **Behavioral anomaly detection** | scikit-learn Isolation Forest |
| **Agent isolation** | Docker (one container per instance) |
| **Guard pipeline** | @agntor/sdk + LLM classifier |
| **Agent** | OpenClaw |
| **API** | FastAPI + Python |
| **Frontend** | React 19 + TypeScript + Vite |

---

## Dashboard

The dashboard is designed for non-technical users — no API keys, no instance names, no infrastructure details. The AI assistant "just works" after login.

| Screen | Purpose |
|--------|---------|
| **Chat** | Full-screen AI conversation — primary interface |
| **Services** | Connect Gmail, Calendar, Slack, GitHub, Drive via Token Vault |
| **Safety** | Dead-Man Switch configuration and check-ins |
| **Activity** | Real-time audit trail of guardrail decisions |
| **Permissions** | Review active scopes, revoke any service instantly |

A single instance is provisioned automatically in the background. No multi-instance management. No "Create & Launch" buttons.

---

## Why Token Vault Is the Whole Point

Every other "secure" tool still requires you to hold a key somewhere. A password manager. A seed phrase. A config file. Something that can be found, extracted, or coerced out of you.

Token Vault eliminates that. The agent is authorized to act. The human is not in possession of the authorization. That's not a UX improvement — it's a physical security guarantee.

*You cannot surrender credentials you do not have.*

---

*Built alone in Addis Ababa — Ethiopia, 145th out of 180 countries for press freedom.*
*This isn't an abstract use case. It's infrastructure for the people who need it most.*
