# AssistantX - Devpost Submission

## Project Title
AssistantX - The AI Assistant That Can't Be Turned Against You

## Short Tagline
Built from Addis Ababa. When they take your device, they take your life's work. AssistantX makes sure there's nothing to take.

## Auth0 Tenant
dev-8enw23ns

## Live Demo
https://assistantx.arcumet.com/
Password: assistantx-demo-2026

## GitHub Repository
https://github.com/Garinmckayl/assistantx

## Video Demo
[YouTube URL - to be added after recording]

---

## Text Description

### Inspiration

Ethiopia is ranked 150th out of 180 countries for press freedom. Journalists are jailed for covering stories the government doesn't want told. Activists are tortured for organizing. People are killed. Not occasionally  - routinely. I'm building this from Addis Ababa. This is not something I read about. This is the world outside my window.

Here is how it works. A corrupt government wants to silence someone. They arrest them. They take their device. And on that device they find everything  - emails, contacts, sources, credentials, every conversation with every person who trusted them enough to talk. One seized laptop doesn't just destroy one life. It destroys everyone connected to it. Sources disappear. Families are interrogated. Lawyers are charged. **People die  - not because of what they did, but because their name was in someone else's inbox.**

The device is the weapon. The credentials are the ammunition.

In 2022 alone, over 4,000 people were arrested in the Amhara region. The Committee to Protect Journalists documented 361 journalists imprisoned worldwide in 2024. But the numbers don't capture it. Behind every arrest is a seized device. Behind every seized device is an entire network of people who are now exposed. Lives ruined. Families destroyed. People killed.

Every AI assistant makes this worse. OpenClaw  - 348,000 stars on GitHub, backed by OpenAI, NVIDIA, GitHub  - connects to your email, your files, your Slack, your calendar. It's the most powerful personal AI ever built. But for a journalist in Addis Ababa, every service it connects to is another credential that can be used to destroy someone's life.

**What if there was no ammunition? What if the credentials simply did not exist on the device?**

That's why I built AssistantX.

### What it does

AssistantX wraps OpenClaw in a security layer built on Auth0 Token Vault. The principle is absolute: **no credential ever touches the user's device.**

You log in with one password. Your Gmail, Google Drive, Slack, GitHub  - all connected, all functional. But every token lives in Auth0 Token Vault. When the assistant needs to send an email, it requests a scoped token from Auth0 that lasts minutes. One use. Then gone. The server never persists it. The device never sees it.

If your laptop is seized tomorrow, they can image the entire drive. Search every file, every database, every cookie, every environment variable. They will find nothing. Because there is nothing.

**But AssistantX goes further.** It doesn't just protect you while you're free. It protects you after you're taken.

**The Dead-Man Switch.** You set a check-in interval  - every 12 hours, every 24 hours. If you miss a check-in because you've been detained, because your phone was confiscated, because you can't reach a screen  - the grace period starts. If that expires:

The agent wakes up. Autonomously. Without you.

It encrypts your pre-staged documents with Fernet symmetric encryption. It uploads them to Google Drive using a token issued by Auth0 Token Vault  - a token you never saw. It emails your trusted contacts  - your lawyer, your editor, your family  - using a Gmail token from the vault. It includes the decryption key.

And then it calls `revoke_all()`. Every token in the vault. Every connection. Burned.

Your story reaches the people who can tell it. Your sources stay protected. Your credentials no longer exist anywhere. **The device is useless. The weapon has no ammunition. No one else gets hurt.**

**Dual-layer guardrails** scan every message  - inbound and outbound  - through `@agntor/sdk` regex heuristics (5ms) and Llama 3.3 70B deep classification (200ms). Prompt injection attempts are blocked before the model ever sees them. Sensitive information in responses is redacted before the user ever sees it. Every decision shows a live verdict badge: PASS, BLOCK, or REDACT.

**A behavioral anomaly detector** (Isolation Forest) monitors every Token Vault access. If the Dead-Man Switch triggers at 3 AM requesting scopes the user has never used, it's flagged. Because the agent acting autonomously should still be accountable.

**A full audit trail** logs every guardrail decision, every token exchange, every Dead-Man Switch event. Because trust isn't a feeling  - it's a record.

### How Auth0 Token Vault is used

Token Vault isn't a feature of AssistantX. It's the reason AssistantX can exist.

**1. Zero-credential device model.** When a user connects Gmail or Google Drive, AssistantX initiates an Auth0 OAuth flow. Tokens are stored by Token Vault  - never on the app server, never on the device. The application only ever receives scoped, short-lived provider tokens via `access_token_for_connection()` that expire in minutes.

**2. Autonomous agent authorization.** The Dead-Man Switch is the first pattern we've seen where an AI agent must act using credentials the user consented to  - but can no longer actively authorize. Token Vault makes this possible: the user consented once, while they were safe. The vault issues tokens when the agent needs them. The user doesn't need to be present.

**3. Total credential destruction.** After the Dead-Man Switch distributes documents and notifications, it calls Auth0's `/oauth/revoke` endpoint to kill the refresh token at Auth0's servers, then clears all local state. The revocation is remote and permanent. Even if the server is later compromised, there is nothing to recover.

**4. Behavioral anomaly detection on vault access.** Every `access_token_for_connection()` call feeds an Isolation Forest  - connection, scopes, time, frequency, trigger type. Token Vault access patterns become a security signal.

### How we built it

- **Backend**: Python 3.12 / FastAPI, `auth0-python` (v4.13) + `auth0-ai` (v1.0.2)
- **Frontend**: React 19 + TypeScript + Vite
- **AI**: OpenClaw agent gateway, Llama 3.3 70B via DO Gradient, `@agntor/sdk` for guardrail heuristics
- **Security**: Fernet encryption, Isolation Forest anomaly detection, real Auth0 `/oauth/revoke`
- **Dead-Man Switch**: asyncio background loop (10s tick), real Gmail API send, real Drive upload, real token revocation
- **Infrastructure**: Docker on Google Cloud, nginx, Auth0 production tenant

### What we learned

**Token Vault is not a credential store. It's an authorization broker.** This distinction matters. A credential store protects secrets at rest. Token Vault issues scoped, time-limited tokens on demand and can destroy them on command. That's a fundamentally different security model  - and it's exactly what makes the Dead-Man Switch possible.

**The Dead-Man Switch is a new authorization pattern.** OAuth assumes the user is present. Token Vault breaks that assumption productively. The user consented once. The agent acts later. And after acting, it revokes everything. We think this pattern has applications far beyond journalism  - whistleblower protection, legal hold compliance, human rights documentation.

### Impact

I didn't build this for a hackathon.

I built it because in my country, a seized laptop doesn't just end a career. It ends lives. A journalist's contact list becomes a target list. A lawyer's case files become evidence against their own clients. An activist's group chat becomes a list of people to arrest next. The credentials on the device aren't just data  - they're the weapon used to destroy everyone in that person's network.

Journalists get jailed. Activists get tortured. Sources get killed. Not because of what they did  - but because their name was on someone else's device.

AssistantX won't stop someone from being arrested. But it will make sure their AI assistant  - the tool that knows the most about them  - has absolutely nothing to give up. No credentials to extract. No contacts to expose. No ammunition.

With Auth0 Token Vault, the device is just a screen. The vault holds everything. And when the worst happens, it burns everything.

**You cannot surrender what you do not have.**

---

---

## BONUS BLOG POST

# The Dead-Man Switch: A New Authorization Pattern for AI Agents Under Threat

*What happens when an AI agent needs to act  - but the user can't authorize it?*

This question isn't theoretical. In 2022, Ethiopian security forces arrested over 4,000 people in the Amhara region. Journalists, activists, lawyers. Devices were seized. Credentials were extracted. Entire networks of sources were exposed from a single laptop.

I'm writing this from Addis Ababa, where I built AssistantX  - an AI assistant where Auth0 Token Vault holds every credential and the device holds nothing. This blog post describes the Dead-Man Switch pattern we developed: a new way to think about agent authorization when the person who granted consent may no longer be free.

## The Problem: Credentials as Evidence

Every AI assistant stores credentials. OAuth tokens in the browser. API keys in `.env` files. Refresh tokens on disk. For most users, this is a convenience tradeoff. For a journalist in a country ranked 145th for press freedom, it's a liability that can end careers, expose sources, and endanger lives.

The problem compounds with every connected service. Gmail tokens reveal who you emailed. Drive tokens reveal what you stored. Slack tokens reveal who you talked to. One seized device becomes a complete map of someone's professional network.

## The Pattern: Dead-Man Switch + Token Vault

We borrowed the Dead-Man Switch from industrial safety. A train operator holds a switch; if they become incapacitated and release it, the train stops. We inverted it: if the user stops checking in, the agent starts acting.

The architecture requires Auth0 Token Vault at every step:

1. **User connects services**  - Gmail, Google Drive via Auth0 OAuth. Tokens stored in Token Vault. Never on the device.
2. **User checks in periodically**  - "I'm alive" button in the Safety tab.
3. **User misses check-in**  - Grace period starts. Trusted contacts are warned.
4. **Grace period expires**  - The agent triggers autonomously:
   - Calls `access_token_for_connection("google-oauth2", ["drive.file"])`  - gets a scoped Google Drive token
   - Encrypts pre-staged documents with Fernet (one-time key per destination)
   - Uploads encrypted payload to Google Drive
   - Calls `access_token_for_connection("google-oauth2", ["gmail.send"])`  - gets a scoped Gmail token
   - Emails trusted contacts via Gmail API with decryption keys
   - Calls Auth0's `/oauth/revoke`  - kills the refresh token remotely
   - Clears all local state

The vault is empty. The device was already clean. The documents are with the people who need them.

## Why This Matters for Token Vault

This pattern reveals something Auth0's documentation doesn't explicitly discuss: **Token Vault can serve autonomous agents acting on behalf of absent users.**

The traditional OAuth model assumes a user is present to consent. Token Vault's `access_token_for_connection()` breaks that assumption. The user consented once  - when they connected the service. Token Vault can issue scoped tokens until the refresh token is revoked. For the Dead-Man Switch, this is exactly right.

The user consented while they were safe. The agent acts when they're not. And after it acts, it revokes everything  - because the user can no longer guarantee their device hasn't been compromised.

## Behavioral Anomaly Detection: A Natural Complement

We added an Isolation Forest trained on vault access patterns. Every `access_token_for_connection()` call is a feature vector: connection, scopes, time, frequency, trigger type.

If the Dead-Man Switch triggers at 3 AM requesting scopes the user never used, the anomaly detector flags it at CRITICAL level in the audit trail. This doesn't block the action  - the switch triggered for a reason  - but it creates accountability.

**Token Vault access logs are an underutilized security signal.** Any application using Token Vault could monitor exchange patterns for compromised agents or unauthorized escalation.

## Insight for Auth0: Consent Decay

The Dead-Man Switch surfaces a gap: **consent decay**. A user who connected Gmail six months ago may not want their agent to still have access. The token is valid, but the consent may not be.

Future Token Vault features could address this:
- **Consent expiry**: auto-revoke after N days of inactivity
- **Trigger-scoped consent**: allow Gmail for normal use, require step-up auth for Dead-Man Switch
- **Consent re-confirmation**: periodic re-authorization for sensitive scopes

The question isn't just "can the agent act?"  - it's "should it still be authorized to?"

## The Line That Stays With Me

I built AssistantX because I watched people lose everything stored on a device. Their work. Their sources. Their contacts' safety. All because the credentials were there.

Auth0 Token Vault made it possible to build an AI assistant where there is nothing to take. Not encrypted. Not hidden. Not there.

**You cannot surrender credentials you do not have.**

Try it: [assistantx.arcumet.com](https://assistantx.arcumet.com) | Code: [github.com/Garinmckayl/assistantx](https://github.com/Garinmckayl/assistantx)
