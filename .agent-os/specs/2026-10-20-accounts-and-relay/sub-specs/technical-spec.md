# Technical Specification

This is the technical specification for the spec detailed in @.agent-os/specs/2026-10-20-accounts-and-relay/spec.md

> Created: 2026-10-20
> Version: 1.0.0

## Architecture

```
 phone (gridhive.dev/app)                    computer (desktop app / npx gridhive)
   │ X25519 key, pairs once via QR               │ X25519 key, RelayClient (outbound only)
   │                                             │
   └──wss──► relay.gridhive.dev ◄──wss───────────┘
             Cloudflare Worker + Durable Object (one per account)
             sees: account id, device ids, ciphertext length. Never plaintext.
                    ▲ verifies relay tokens (Ed25519, public key)
                    │
 gridhive.dev (Vercel) ── sign-in (GitHub / Google / email link), device linking,
                          relay tokens (signed with the private key), waitlist
                    │
                  Neon Postgres: users, auth accounts, sessions, devices, waitlist
```

## Technical Requirements

- **Sign-in:** Auth.js core (`@auth/core`) in Vercel functions with the Neon adapter (`@auth/neon-adapter`); providers GitHub, Google, Resend (email link). Database sessions, HttpOnly secure cookies on gridhive.dev.
- **Device linking (computer):** OAuth-style device code flow. The app calls `POST /api/devices/start`, shows a short code and opens `gridhive.dev/link?code=…`; the signed-in user confirms; the app polls `POST /api/devices/token` and receives a device secret (shown once, stored in `~/.agentarmy/cloud.json`, 0600). The app never handles passwords.
- **Relay tokens:** `POST /api/relay/token` (device secret or web session) returns a 10-minute Ed25519-signed token `{ sub: userId, dev: deviceId, kind: 'computer' | 'phone' }`. The Worker verifies it with the public key (no shared secret on Cloudflare, no database calls on the hot path).
- **Relay:** Worker routes `wss://relay.gridhive.dev/v1/connect` to the account's Durable Object (hibernatable WebSockets). Frames `{ to, from, nonce, box }` are forwarded unchanged to the target device; the DO keeps only who is online. Limits: 1 MB frame, 200 frames/s per device, 20 devices per account.
- **End-to-end encryption:** each device has an X25519 key pair (WebCrypto). Phone ↔ computer pairing happens once via a QR code on the computer that carries the computer's public key and a one-time code, so the relay cannot swap keys. Frames are sealed with an ECDH-derived AES-256-GCM key, a counter nonce, and the sender/receiver ids as associated data.
- **Same protocol as Wi-Fi:** inside the encrypted channel the phone sends the same calls as on Wi-Fi (`/m/api/<path>` RPC and the `/m/ws` messages). On the computer, `RelayClient` feeds them into the existing `PhoneService` allow-list, so both transports share one code path and one set of rules.
- **Phone app hosting:** `npm run build` also emits the phone bundle for the site (`site/app/`), served at gridhive.dev/app with a transport switch (Wi-Fi: same-origin `/m/*`; relay: encrypted WebSocket).
- **Revocation:** removing a device (website or app) deletes its row; the Worker drops its socket when its token expires (≤ 10 min), or immediately via a `POST /revoke` call from Vercel to the DO.

## Approach Options

**Option A:** Vercel + Neon only (SSE plus Neon as a mailbox)
- Pros: one fewer provider
- Cons: no WebSockets on Vercel; the terminal would refresh every ~2 s

**Option B:** Vercel + Neon + Cloudflare relay (Selected)
- Pros: live terminals; Durable Objects are made for per-account fan-out; free tier to start
- Cons: one more account (Cloudflare) and deploy target (`wrangler`)

**Rationale:** the owner chose Cloudflare for the relay (2026-10-20); live terminals matter for the phone experience.

## External Dependencies

- **@neondatabase/serverless 1.2.0** - Neon HTTP driver for Vercel functions (waitlist, auth)
- **@auth/core + @auth/neon-adapter** - sign-in with GitHub, Google and email links without a framework
- **resend** - sends email sign-in links (free tier, needs a verified gridhive.dev domain)
- **wrangler (dev only)** - builds and deploys the Cloudflare Worker
- **Justification:** each is the most used, actively maintained option for its job; nothing new runs inside the desktop app except WebCrypto (built in)

## What the owner sets up (never done by the agent)

1. Vercel: add Neon from the Marketplace to the site project (sets `DATABASE_URL`); point gridhive.dev to Vercel.
2. GitHub OAuth app and Google OAuth client with callback `https://gridhive.dev/api/auth/callback/<provider>`; put the ids/secrets in Vercel env vars.
3. Resend account, verify gridhive.dev, `RESEND_API_KEY` in Vercel.
4. Cloudflare account; run `npx wrangler login` in a terminal; add `relay.gridhive.dev` as a custom domain.
5. Generate the Ed25519 relay key pair (`npm run relay:keys`); private key in Vercel, public key in the Worker config.
