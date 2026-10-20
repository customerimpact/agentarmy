# API Specification

This is the API specification for the spec detailed in @.agent-os/specs/2026-10-20-accounts-and-relay/spec.md

> Created: 2026-10-20
> Version: 1.0.0

## Endpoints (Vercel, gridhive.dev)

### POST /api/waitlist

**Purpose:** Early-access signup (built)
**Parameters:** `{ email, source?, company? }` (`company` is a honeypot)
**Response:** `{ ok: true }` (same for repeats and bots)
**Errors:** 400 bad email, 405 not POST, 503 no database yet

### GET|POST /api/auth/*

**Purpose:** Auth.js routes (sign-in, callback, sign-out, session) for GitHub, Google, Resend
**Response:** redirects and the session cookie

### POST /api/devices/start

**Purpose:** A computer asks to be linked
**Parameters:** `{ name, publicKey }`
**Response:** `{ deviceCode, userCode, verifyUrl, interval, expiresIn }`

### POST /api/devices/confirm

**Purpose:** Signed-in user approves `userCode` on gridhive.dev/link
**Response:** `{ ok: true }`
**Errors:** 401 not signed in, 404 unknown or expired code

### POST /api/devices/token

**Purpose:** The computer polls until linked
**Parameters:** `{ deviceCode }`
**Response:** `{ deviceId, deviceSecret }` once; `{ pending: true }` before
**Errors:** 410 expired

### POST /api/relay/token

**Purpose:** Short-lived relay token
**Parameters:** device secret (Authorization: Bearer) or web session cookie (phone)
**Response:** `{ token, expiresAt, relayUrl }`

### GET /api/devices, DELETE /api/devices/:id

**Purpose:** List and remove linked computers and phones (website account page and the app)

## Relay (Cloudflare, relay.gridhive.dev)

### GET /v1/connect (WebSocket upgrade)

**Parameters:** `?token=<relay token>`
**Messages:** `{ to, from, nonce, box }` forwarded as-is; `{ type: 'presence', devices: [...] }` sent by the relay
**Errors:** close 4401 bad or expired token, 4429 rate limited

### POST /v1/revoke (from Vercel, signed)

**Purpose:** Drop a removed device's socket right away
