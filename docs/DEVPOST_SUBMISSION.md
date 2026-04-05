# AssistantX — Devpost Submission

## Project Title
AssistantX — The AI Assistant That Can't Be Turned Against You

## Short Tagline
Built from Addis Ababa for journalists under threat. Auth0 Token Vault holds every credential — the device holds nothing. You cannot surrender what you do not have.

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

I'm building this from Addis Ababa, Ethiopia — ranked 145th out of 180 for press freedom. Over 4,000 dissidents were arrested in a single crackdown in the Amhara region. Journalists, activists, lawyers — held for months in military camps without charge. The government doesn't distinguish between covering a conflict and promoting terrorism.

When they take you, they take your device. Your emails, your sources, your contacts, your credentials — all of it, sitting right there on the laptop. Not just yours. Everyone you've ever communicated with.

OpenClaw is the most popular open-source AI assistant in the world — 348,000 stars on GitHub, backed by OpenAI, NVIDIA, and GitHub. It connects to your email, your files, your calendar, your Slack. It's incredibly powerful. But if you're a journalist in Addis Ababa, every service OpenClaw connects to is another credential on your device. Another token for someone to extract.

AssistantX exists because I watched this happen. Not on the news — around me. And I kept thinking: what if the credentials just weren't there? Not encrypted. Not hidden. **Not there at all.**

### What it does

AssistantX is built on top of OpenClaw. It gives you all that power — but moves every credential off the device and into Auth0 Token Vault. One password to log in. No API keys. No OAuth tokens saved anywhere. Nothing.

**Five screens, one principle: the device holds nothing.**

- **Chat** — AI assistant with dual-layer guardrails (semantic scan + Llama 3.3 70B classification) on every message. Each response shows a live verdict badge: PASS, BLOCK, or REDACT. If someone tries to trick the AI into leaking your sources, it gets blocked before anyone sees it.

- **Services** — Connect Gmail, Google Drive, GitHub, Slack via Auth0 OAuth. Tokens live in Token Vault — never on this server, never on this device. When the assistant needs to send an email, it asks Auth0 for a token that lasts minutes, uses it once, and it's gone.

- **Safety** — The Dead-Man Switch. Set a check-in interval. If you miss it — because you've been detained, because your phone was taken — the agent wakes up on its own. It encrypts your documents, uploads them to Google Drive using a vault-issued token, emails your trusted contacts via Gmail using another vault-issued token, and then calls revoke-all. Every token burned. The vault is empty. The device was already clean.

- **Activity** — Full audit trail. Every guardrail decision, every token exchange, every Dead-Man Switch event. Because trust isn't a feeling — it's a record.

- **Permissions** — One screen showing every service the agent can access. One click to revoke. Even the Dead-Man Switch can only be re-armed by a trusted contact — not the user — because if the user is compromised, the user's authorization means nothing.

### How Auth0 Token Vault is used

Token Vault isn't a feature of AssistantX. It's the thesis.

**1. Service connection:** When a user clicks "Connect" on Gmail or Google Drive, AssistantX initiates an Auth0 OAuth flow. The authorization code is exchanged via Auth0's `/oauth/token` endpoint. Tokens are stored by Token Vault — never persisted on the application server.

**2. Per-request token exchange:** When the AI agent needs to access an external service, the backend calls `GetToken.access_token_for_connection()` from the `auth0-python` SDK. Auth0 exchanges the stored refresh token for a scoped, short-lived provider token. It exists in memory for one API call, then is discarded.

**3. Dead-Man Switch — autonomous agent action:** When the switch triggers (missed check-in + grace expired), the agent uses Token Vault to obtain:
- Google Drive token (scope: `drive.file`) → encrypts and uploads documents
- Gmail token (scope: `gmail.send`) → notifies trusted contacts with Fernet-encrypted decryption keys
- Then calls Auth0's `/oauth/revoke` endpoint to kill the refresh token remotely, followed by clearing all local state

The user consented once, while they were safe. The agent acts when they're not. And after it acts, it burns everything.

**4. Behavioral anomaly detection:** Every `access_token_for_connection()` call feeds an Isolation Forest detector — connection name, scopes, time of day, request rate, trigger type. If the Dead-Man Switch triggers at 3 AM requesting scopes the user has never used, it's flagged at CRITICAL level in the audit trail.

### How we built it

- **Backend**: Python 3.12 / FastAPI, `auth0-python` (v4.13) + `auth0-ai` (v1.0.2) for Token Vault operations
- **Frontend**: React 19 + TypeScript + Vite
- **AI**: OpenClaw agent gateway with Llama 3.3 70B via DO Gradient for guardrails
- **Encryption**: Fernet symmetric encryption with per-destination one-time keys
- **Anomaly Detection**: scikit-learn Isolation Forest on vault access patterns
- **Dead-Man Switch**: Real asyncio background loop (10s tick), real Gmail send, real Drive upload, real Auth0 token revocation
- **Infrastructure**: Docker on Google Cloud, nginx, Auth0 production tenant

### Challenges

- **Autonomous token exchange without a user present.** Token Vault's `access_token_for_connection()` is designed for flows where a user has an active session. Making it work for the Dead-Man Switch — where the agent acts hours after the user's last interaction — required careful refresh token lifecycle management.

- **UX under duress.** The hardest design problem wasn't technical — it was deciding what to show. Non-technical users under stress need to trust the tool instantly. That meant verdict badges on every message, a visible Token Vault banner, and zero configuration steps.

### What we learned

- **Token Vault is an authorization broker, not a credential store.** The "exchange on demand, never persist" pattern is fundamentally different from how most apps handle OAuth. Once we internalized this, the architecture simplified dramatically.

- **The Dead-Man Switch is a new pattern for agent authorization.** An agent that acts autonomously using credentials the user consented to — but can no longer actively authorize — pushes the boundaries of what "authorized to act" means.

- **OpenClaw is the best AI assistant ever built. But without a security layer, it's the best evidence collection tool ever built too.** Auth0 Token Vault makes it possible to give people OpenClaw's power with none of the risk.

### Impact

Over 4,000 people arrested in one crackdown. Every device seized. Every credential extracted. Their contacts, their sources, their entire network — pulled from a laptop.

What if there were no credentials to find?

That's what AssistantX does. Not someday. Now.

---

---

## BONUS BLOG POST

# The Dead-Man Switch Pattern: When Token Vault Authorizes an Agent to Act Without You

When we started building AssistantX, we had a simple question: what happens when an AI agent needs to act, but the user can't authorize it in real time?

This isn't hypothetical. Journalists in conflict zones, activists under surveillance, lawyers handling sensitive cases — these people face scenarios where they may suddenly become unreachable. Their devices may be seized. Their accounts may be compromised. The question isn't whether their AI assistant can help them draft an email. It's whether it can act on their behalf when they're gone.

## The Pattern: Dead-Man Switch + Token Vault

The Dead-Man Switch is borrowed from industrial safety. A train operator holds a switch; if they release it (because they're incapacitated), the train stops. We inverted it: if the user stops checking in, the agent starts acting.

Here's the flow:

1. The user configures a check-in interval (e.g., every 12 hours) and a grace period.
2. They connect Gmail and Google Drive via Auth0 OAuth. Tokens are stored in Auth0 Token Vault — not on the device.
3. The user checks in periodically by pressing "I'm alive" in the Safety tab.
4. If they miss a check-in and the grace period expires, the agent triggers autonomously.

The trigger sequence uses Token Vault at every step:

- **Step 1**: Call `access_token_for_connection("google-oauth2", ["drive.file"])` — Auth0 exchanges the stored refresh token for a scoped Google Drive access token.
- **Step 2**: Encrypt the user's pre-staged documents with Fernet symmetric encryption (one-time key per destination) and upload to Drive.
- **Step 3**: Call `access_token_for_connection("google-oauth2", ["gmail.send"])` — get a scoped Gmail token.
- **Step 4**: Send notification emails to trusted contacts via the Gmail API, including the decryption keys.
- **Step 5**: Call Auth0's `/oauth/revoke` to kill the refresh token remotely. Then clear all local state. The vault is empty. The device is clean.

## Why This Matters for Token Vault

This pattern reveals something important about Token Vault's architecture: it's not just for interactive OAuth flows. It's an authorization broker that can serve autonomous agents acting on behalf of absent users.

The traditional OAuth model assumes a user is present to consent. Token Vault's `access_token_for_connection()` breaks that assumption productively — the user consented once (when they connected the service), and Token Vault can issue scoped tokens on their behalf until the refresh token is revoked.

For the Dead-Man Switch, this is exactly right. The user consented while they were safe. The agent acts when they're not. And after it acts, it revokes everything, because the user can no longer be certain their device hasn't been compromised.

## Behavioral Anomaly Detection on Vault Access

We added a layer most Token Vault integrations don't have: behavioral anomaly detection using an Isolation Forest trained on vault access patterns.

Every call to `access_token_for_connection()` is recorded as a feature vector — connection name, scopes requested, time of day, request rate, trigger type (normal vs. Dead-Man Switch).

If the Dead-Man Switch triggers at 3 AM requesting scopes the user has never used, the anomaly detector flags it. This doesn't block the action — the switch triggered for a reason — but it logs the event at CRITICAL level in the audit trail. If the user regains access, they can see exactly what happened and when.

This points to a broader pattern: **Token Vault access logs are a rich signal for anomaly detection.** Any application using Token Vault could benefit from monitoring token exchange patterns for signs of compromised agents or unauthorized access escalation.

## Insight for Auth0: Consent Decay

The Dead-Man Switch pattern surfaces a gap in how we think about agent authorization: **consent decay**.

A user who connected their Gmail six months ago may not remember or want their agent to have that access today. Token Vault stores the credential, but it doesn't model the user's evolving intent. The token is valid, but the consent may no longer be.

A future version of Token Vault could address this with:

- **Consent expiry**: auto-revoke connections after N days of inactivity
- **Consent re-confirmation**: require periodic re-authorization for sensitive scopes
- **Trigger-scoped consent**: allow Gmail access for normal operations, but require step-up authentication for Dead-Man Switch distribution

These aren't bugs — they're design opportunities that emerge when you push Token Vault into autonomous agent territory. The "Authorized to Act" framing is exactly right: the question isn't just "can the agent act?" but "should it still be authorized to?"

## Try It

AssistantX is live at [https://assistantx.arcumet.com](https://assistantx.arcumet.com). The code is open source on [GitHub](https://github.com/Garinmckayl/assistantx). Connect a Gmail account, configure the Dead-Man Switch with a 1-minute demo interval, and watch the real engine fire — Token Vault holding credentials you never touch, exchanging them on demand, and burning them when the time comes.

You cannot surrender credentials you do not have.
