# AssistantX — Dead-Man Switch

> *She couldn't give them the passwords. She never had them. The vault did. And the vault was already done.*

**AssistantX** is a hardened proxy that sits in front of OpenClaw with **Auth0 Token Vault** at its core.

The agent acts on your behalf. You never hold the credentials. You cannot be coerced into surrendering what you do not have.

Built for the [Authorized to Act Hackathon](https://authorizedtoact.devpost.com/) — on top of [Ombre](https://github.com/Garinmckayl/ombre), winner of the DigitalOcean Gradient AI Hackathon.

---

## The Problem

Ethiopia ranks **145th out of 180 countries** for press freedom. "Very serious" is the official classification.

A journalist here has an AI assistant. It reads their notes. It has access to their sources, their drafts, their secure communications. It's the most powerful tool they have — and the most dangerous thing they own.

If they're arrested, their phone is taken. Their accounts are accessed. The credentials their agent holds become evidence, or leverage, or a death sentence.

**AssistantX eliminates that attack surface entirely.**

The user never holds credentials. Auth0 Token Vault holds them. The agent is authorized to act within explicit scopes — nothing more. And when the check-in pulse stops arriving, the protocol executes automatically:

1. Token Vault issues a **write-once, 60-minute encrypt-and-distribute token**
2. Files are encrypted and pushed to secure mirrors in 3+ countries
3. Trusted contacts are notified
4. Token Vault issues **revoke-all** — the vault is emptied, scorched earth

You cannot be tortured for keys you don't have. The vault held them. The vault is done.

---

## Architecture

```
User / Message
      │
      ▼
┌─────────────────────────────────────┐
│         AssistantX Proxy            │
│                                     │
│  ┌─────────────────────────────┐    │
│  │  Guard Layer 1              │    │  ← @agntor/sdk semantic (~5ms)
│  │  (heuristic + PII scan)     │    │
│  └──────────────┬──────────────┘    │
│                 │                   │
│  ┌──────────────▼──────────────┐    │
│  │  Guard Layer 2              │    │  ← LLM classification (~200ms)
│  │  (AI deep scan)             │    │
│  └──────────────┬──────────────┘    │
│                 │                   │
│  ┌──────────────▼──────────────┐    │
│  │  Auth0 Token Vault          │    │  ← Scoped token issued per action
│  │                             │    │    Raw credentials NEVER on machine
│  │  Dead-Man Switch Monitor    │    │  ← Background loop, 60s tick
│  └──────────────┬──────────────┘    │
└─────────────────┼───────────────────┘
                  │
                  ▼
          OpenClaw Agent
                  │
                  ▼
      Third-party API call
      (scoped token, not master key)
```

---

## What Auth0 Token Vault Replaces

AssistantX (the base) used an in-memory dict to store credentials:

```python
# Before — AssistantX secrets.py
_vault: Dict[str, Dict[str, str]] = {}  # raw keys in memory
```

AssistantX replaces this entirely with Token Vault:

```python
# After — AssistantX token_vault.py
token = await vault.issue_token(
    instance_id,
    TokenScope.OPENCLAW_ANTHROPIC,
    ttl_seconds=3600,        # expires in 1 hour
    write_once=False,
)
# Raw credential never stored. Scoped token issued per request.
```

For the Dead-Man Switch, Token Vault issues a special set of one-time tokens:

```python
# On trigger — token_vault.py
tokens = await vault.issue_deadman_tokens(instance_id)
# encrypt-and-distribute: write-once, 60min
# notify-contacts:        send-only, 30min
# revoke-all:             scorched earth, 5min
```

---

## API Endpoints

### Dead-Man Switch

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/deadman/{id}/setup` | Configure the switch — contacts, destinations, schedule |
| `POST` | `/api/deadman/{id}/checkin` | Send a check-in pulse with the correct word |
| `GET`  | `/api/deadman/{id}/status` | Current state, timing, distribution log |
| `POST` | `/api/deadman/{id}/rearm` | Re-arm after trigger (trusted contact step-up) |
| `POST` | `/api/deadman/{id}/simulate` | Demo: simulate missed check-in or trigger |
| `GET`  | `/api/deadman/{id}/vault` | List active vault tokens (consent view) |

### Consent & Token Vault

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/consent/{id}` | Full consent view — every active scope |
| `POST`   | `/api/consent/{id}/authorize` | Authorize a service via OAuth |
| `DELETE` | `/api/consent/{id}/revoke` | Revoke a specific scope |
| `POST`   | `/api/consent/{id}/revoke-all` | Revoke everything |

### Existing AssistantX endpoints (guardrail proxy, instances, audit)

All AssistantX endpoints preserved. Full guardrail pipeline (97.8% accuracy, 100% recall) still active on every message.

---

## Token Scopes

| Scope | Description | TTL | Write-Once |
|-------|-------------|-----|------------|
| `encrypt-and-distribute` | Fires on Dead-Man trigger. Pushes to secure mirrors. | 60 min | ✓ |
| `notify-contacts` | Send-only to trusted contacts. | 30 min | ✗ |
| `revoke-all` | Empties the vault after protocol completes. | 5 min | ✓ |
| `agent-read` | Read-only for normal operations. | 24 hrs | ✗ |
| `agent-write` | Write ops. Step-up auth required. | 1 hr | ✗ |
| `openclaw:anthropic` | Narrow Anthropic API access. | 1 hr | ✗ |
| `openclaw:openai` | Narrow OpenAI API access. | 1 hr | ✗ |
| `openclaw:gemini` | Narrow Gemini API access. | 1 hr | ✗ |

---

## Quickstart

```bash
git clone https://github.com/Garinmckayl/assistantx
cd assistantx && cp .env.example .env
```

```env
# Auth0 Token Vault (required for production, optional for demo)
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_MGMT_TOKEN=your-management-api-token
AUTH0_CLIENT_ID=your-client-id

# Demo mode (works without Auth0)
ASSISTANTX_DEMO_MODE=true

# Guardrail (from Ombre)
GEMINI_API_KEY=your-gemini-key
```

```bash
pip install -r requirements.txt
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
      {"name": "Sarah", "email": "sarah@example.com", "can_rearm": true}
    ],
    "secure_destinations": [
      {"name": "GitHub Mirror", "type": "github",
       "url": "https://api.github.com/repos/you/secure-repo/contents/deadman.json"}
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
ASSISTANTX_DEMO_MODE=true \
curl -X POST http://localhost:8000/api/deadman/my-instance/simulate \
  -d '{"scenario": "trigger"}'

# Watch the protocol execute:
curl http://localhost:8000/api/deadman/my-instance/status
```

---

## Built On

| Layer | Technology |
|-------|-----------|
| **Identity & tokens** | Auth0 Token Vault |
| **Guardrail engine** | AssistantX (DigitalOcean Gradient AI, @agntor/sdk) |
| **Agent** | OpenClaw |
| **API** | FastAPI + Python |
| **Frontend** | React + TypeScript |
| **Evaluation** | 97.8% accuracy, 100% recall on 45-case adversarial dataset |

---

## Why Token Vault Is the Whole Point

Every other "secure" tool still requires you to hold a key somewhere. A password manager. A seed phrase. A config file. Something that can be found, extracted, or coerced out of you.

Token Vault eliminates that. The agent is authorized to act. The human is not in possession of the authorization. That's not a UX improvement — it's a physical security guarantee.

*You cannot surrender credentials you do not have.*

---

*Built alone in Addis Ababa — Ethiopia, 145th out of 180 countries for press freedom.*
*This isn't an abstract use case. It's infrastructure for the people who need it most.*
