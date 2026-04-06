# AssistantX — Devpost Submission

## Project Title
AssistantX — The AI Assistant That Can't Be Turned Against You

## Short Tagline
Built from Addis Ababa. When they take your device, they take your life's work. AssistantX makes sure there's nothing to take.

## Live Demo
https://assistantx.arcumet.com/
Password: assistantx-demo-2026

## GitHub Repository
https://github.com/Garinmckayl/assistantx

## Video Demo
[YouTube URL — to be added after recording]

---

## Text Description

### Inspiration

In 2022, security forces in Ethiopia arrested over 4,000 people in the Amhara region alone. Journalists. Activists. Human rights lawyers. Many were held in military camps for months — some for over a year — without formal charges. Their crime? Covering a conflict the government wanted invisible.

I know what happens next, because I'm building this from Addis Ababa.

When they detain someone, the first thing seized is always the device. And on that device is everything: Gmail credentials, OAuth tokens in the browser, API keys in config files, contacts, sources, drafts, every conversation with every person who trusted them enough to talk. One laptop becomes a map of an entire network. People who had nothing to do with the story get pulled in. Families get interrogated. Sources disappear.

This isn't unique to Ethiopia. The Committee to Protect Journalists documented 361 journalists imprisoned worldwide in 2024. Reporters Without Borders ranks us 145th out of 180 for press freedom. But the pattern is always the same everywhere: the credentials were on the device, so the credentials were taken.

I kept thinking: every AI assistant makes this worse. OpenClaw — 348,000 stars on GitHub, backed by OpenAI, NVIDIA, GitHub — connects to your email, your files, your Slack, your calendar. It's the most powerful personal AI ever built. But for a journalist in Addis Ababa, every service it connects to is another credential on the device. Another token someone can extract. Another person who gets exposed.

**What if the credentials weren't there at all? Not encrypted. Not hidden. Gone.**

That's why I built AssistantX.

### What it does

AssistantX wraps OpenClaw in a security layer built on Auth0 Token Vault. The principle is absolute: **no credential ever touches the user's device.**

You log in with one password. Your Gmail, Google Drive, Slack, GitHub — all connected, all functional. But every token lives in Auth0 Token Vault. When the assistant needs to send an email, it requests a scoped token from Auth0 that lasts minutes. One use. Then gone. The server never persists it. The device never sees it.

If your laptop is seized tomorrow, they can image the entire drive. Search every file, every database, every cookie, every environment variable. They will find nothing. Because there is nothing.

**But AssistantX goes further.** It doesn't just protect you while you're free. It protects you after you're taken.

**The Dead-Man Switch.** You set a check-in interval — every 12 hours, every 24 hours. If you miss a check-in because you've been detained, because your phone was confiscated, because you can't reach a screen — the grace period starts. If that expires:

The agent wakes up. Autonomously. Without you.

It encrypts your pre-staged documents with Fernet symmetric encryption. It uploads them to Google Drive using a token issued by Auth0 Token Vault — a token you never saw. It emails your trusted contacts — your lawyer, your editor, your family — using a Gmail token from the vault. It includes the decryption key.

And then it calls `revoke_all()`. Every token in the vault. Every connection. Burned.

Your documents reached the people who need them. Your credentials no longer exist anywhere. The device was already clean. **Whoever took it is holding a brick.**

**Dual-layer guardrails** scan every message — inbound and outbound — through `@agntor/sdk` regex heuristics (5ms) and Llama 3.3 70B deep classification (200ms). Prompt injection attempts are blocked before the model ever sees them. Sensitive information in responses is redacted before the user ever sees it. Every decision shows a live verdict badge: PASS, BLOCK, or REDACT.

**A behavioral anomaly detector** (Isolation Forest) monitors every Token Vault access. If the Dead-Man Switch triggers at 3 AM requesting scopes the user has never used, it's flagged. Because the agent acting autonomously should still be accountable.

**A full audit trail** logs every guardrail decision, every token exchange, every Dead-Man Switch event. Because trust isn't a feeling — it's a record.

### How Auth0 Token Vault is used

Token Vault isn't a feature of AssistantX. It's the reason AssistantX can exist.

**1. Zero-credential device model.** When a user connects Gmail or Google Drive, AssistantX initiates an Auth0 OAuth flow. Tokens are stored by Token Vault — never on the app server, never on the device. The application only ever receives scoped, short-lived provider tokens via `access_token_for_connection()` that expire in minutes.

**2. Autonomous agent authorization.** The Dead-Man Switch is the first pattern we've seen where an AI agent must act using credentials the user consented to — but can no longer actively authorize. Token Vault makes this possible: the user consented once, while they were safe. The vault issues tokens when the agent needs them. The user doesn't need to be present.

**3. Total credential destruction.** After the Dead-Man Switch distributes documents and notifications, it calls Auth0's `/oauth/revoke` endpoint to kill the refresh token at Auth0's servers, then clears all local state. The revocation is remote and permanent. Even if the server is later compromised, there is nothing to recover.

**4. Behavioral anomaly detection on vault access.** Every `access_token_for_connection()` call feeds an Isolation Forest — connection, scopes, time, frequency, trigger type. Token Vault access patterns become a security signal.

### How we built it

- **Backend**: Python 3.12 / FastAPI, `auth0-python` (v4.13) + `auth0-ai` (v1.0.2)
- **Frontend**: React 19 + TypeScript + Vite
- **AI**: OpenClaw agent gateway, Llama 3.3 70B via DO Gradient, `@agntor/sdk` for guardrail heuristics
- **Security**: Fernet encryption, Isolation Forest anomaly detection, real Auth0 `/oauth/revoke`
- **Dead-Man Switch**: asyncio background loop (10s tick), real Gmail API send, real Drive upload, real token revocation
- **Infrastructure**: Docker on Google Cloud, nginx, Auth0 production tenant

### What we learned

**Token Vault is not a credential store. It's an authorization broker.** This distinction matters. A credential store protects secrets at rest. Token Vault issues scoped, time-limited tokens on demand and can destroy them on command. That's a fundamentally different security model — and it's exactly what makes the Dead-Man Switch possible.

**The Dead-Man Switch is a new authorization pattern.** OAuth assumes the user is present. Token Vault breaks that assumption productively. The user consented once. The agent acts later. And after acting, it revokes everything. We think this pattern has applications far beyond journalism — whistleblower protection, legal hold compliance, human rights documentation.

### Impact

I didn't build this for a hackathon.

I built it because people I know have had their devices seized. Because the evidence used to charge them came from their own laptops — their own tokens, their own credentials, their own contact lists. Because one confiscated device can expose an entire network of sources, lawyers, and family members who had nothing to do with the story.

Over 4,000 people arrested in one crackdown. Every device seized. Every credential extracted. Their contacts, their sources, their entire network — pulled from a laptop.

AssistantX can't stop someone from being detained. But it can make sure their AI assistant — the tool that knows the most about them — has nothing to give up.

**You cannot surrender what you do not have.**

---

---

## BONUS BLOG POST

# The Dead-Man Switch: A New Authorization Pattern for AI Agents Under Threat

*What happens when an AI agent needs to act — but the user can't authorize it?*

This question isn't theoretical. In 2022, Ethiopian security forces arrested over 4,000 people in the Amhara region. Journalists, activists, lawyers. Devices were seized. Credentials were extracted. Entire networks of sources were exposed from a single laptop.

I'm writing this from Addis Ababa, where I built AssistantX — an AI assistant where Auth0 Token Vault holds every credential and the device holds nothing. This blog post describes the Dead-Man Switch pattern we developed: a new way to think about agent authorization when the person who granted consent may no longer be free.

## The Problem: Credentials as Evidence

Every AI assistant stores credentials. OAuth tokens in the browser. API keys in `.env` files. Refresh tokens on disk. For most users, this is a convenience tradeoff. For a journalist in a country ranked 145th for press freedom, it's a liability that can end careers, expose sources, and endanger lives.

The problem compounds with every connected service. Gmail tokens reveal who you emailed. Drive tokens reveal what you stored. Slack tokens reveal who you talked to. One seized device becomes a complete map of someone's professional network.

## The Pattern: Dead-Man Switch + Token Vault

We borrowed the Dead-Man Switch from industrial safety. A train operator holds a switch; if they become incapacitated and release it, the train stops. We inverted it: if the user stops checking in, the agent starts acting.

The architecture requires Auth0 Token Vault at every step:

1. **User connects services** — Gmail, Google Drive via Auth0 OAuth. Tokens stored in Token Vault. Never on the device.
2. **User checks in periodically** — "I'm alive" button in the Safety tab.
3. **User misses check-in** — Grace period starts. Trusted contacts are warned.
4. **Grace period expires** — The agent triggers autonomously:
   - Calls `access_token_for_connection("google-oauth2", ["drive.file"])` — gets a scoped Google Drive token
   - Encrypts pre-staged documents with Fernet (one-time key per destination)
   - Uploads encrypted payload to Google Drive
   - Calls `access_token_for_connection("google-oauth2", ["gmail.send"])` — gets a scoped Gmail token
   - Emails trusted contacts via Gmail API with decryption keys
   - Calls Auth0's `/oauth/revoke` — kills the refresh token remotely
   - Clears all local state

The vault is empty. The device was already clean. The documents are with the people who need them.

## Why This Matters for Token Vault

This pattern reveals something Auth0's documentation doesn't explicitly discuss: **Token Vault can serve autonomous agents acting on behalf of absent users.**

The traditional OAuth model assumes a user is present to consent. Token Vault's `access_token_for_connection()` breaks that assumption. The user consented once — when they connected the service. Token Vault can issue scoped tokens until the refresh token is revoked. For the Dead-Man Switch, this is exactly right.

The user consented while they were safe. The agent acts when they're not. And after it acts, it revokes everything — because the user can no longer guarantee their device hasn't been compromised.

## Behavioral Anomaly Detection: A Natural Complement

We added an Isolation Forest trained on vault access patterns. Every `access_token_for_connection()` call is a feature vector: connection, scopes, time, frequency, trigger type.

If the Dead-Man Switch triggers at 3 AM requesting scopes the user never used, the anomaly detector flags it at CRITICAL level in the audit trail. This doesn't block the action — the switch triggered for a reason — but it creates accountability.

**Token Vault access logs are an underutilized security signal.** Any application using Token Vault could monitor exchange patterns for compromised agents or unauthorized escalation.

## Insight for Auth0: Consent Decay

The Dead-Man Switch surfaces a gap: **consent decay**. A user who connected Gmail six months ago may not want their agent to still have access. The token is valid, but the consent may not be.

Future Token Vault features could address this:
- **Consent expiry**: auto-revoke after N days of inactivity
- **Trigger-scoped consent**: allow Gmail for normal use, require step-up auth for Dead-Man Switch
- **Consent re-confirmation**: periodic re-authorization for sensitive scopes

The question isn't just "can the agent act?" — it's "should it still be authorized to?"

## The Line That Stays With Me

I built AssistantX because I watched people lose everything stored on a device. Their work. Their sources. Their contacts' safety. All because the credentials were there.

Auth0 Token Vault made it possible to build an AI assistant where there is nothing to take. Not encrypted. Not hidden. Not there.

**You cannot surrender credentials you do not have.**

Try it: [assistantx.arcumet.com](https://assistantx.arcumet.com) | Code: [github.com/Garinmckayl/assistantx](https://github.com/Garinmckayl/assistantx)
