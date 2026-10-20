# Spec Tasks

These are the tasks to be completed for the spec detailed in @.agent-os/specs/2026-10-20-accounts-and-relay/spec.md

> Created: 2026-10-20
> Status: Ready for Implementation

## Tasks

- [x] 1. Waitlist on gridhive.dev
  - [x] 1.1 Write tests for the waitlist handler
  - [x] 1.2 POST /api/waitlist on Vercel with Neon (honeypot, one row per email)
  - [x] 1.3 "Get early access" form on the homepage (after the Kaizo-palette restyle)
  - [x] 1.4 Privacy notice: waitlist emails, how to be removed
  - [x] 1.5 Owner: add Neon to the Vercel project; point gridhive.dev to Vercel
  - [x] 1.6 Verify a signup lands in Neon on the live site

- [ ] 2. Accounts (Auth.js on Vercel, Neon adapter)
  - [x] 2.1 Write tests for sign-in, callback and sessions (site/api/auth.test.mjs)
  - [x] 2.2 Tables users, auth_accounts, sessions (created on first sign-in)
  - [x] 2.3 GitHub and Google sign-in (own OAuth + PKCE instead of Auth.js: no framework on the site); gridhive.dev/account
  - [ ] 2.3b Email link via Resend (needs a Resend account)
  - [x] 2.4 Owner: GitHub + Google OAuth apps, secrets in Vercel
  - [ ] 2.5 Verify all tests pass

- [ ] 3. Link a computer (device code flow)
  - [ ] 3.1 Write tests for codes, polling and secrets
  - [ ] 3.2 /api/devices/* and gridhive.dev/link page
  - [ ] 3.3 "Sign in to GridHive" in Settings (desktop app and npx)
  - [ ] 3.4 Verify all tests pass

- [ ] 4. Cloudflare relay
  - [x] 4.1 Write relay tests (token check and forwarding rules, relay/test)
  - [x] 4.2 Worker + DO, Ed25519 token check, limits, presence, revoke (deployed: gridhive-relay.gridhive-relay.workers.dev)
  - [ ] 4.3 /api/relay/token on Vercel
  - [x] 4.4 Owner: Cloudflare account (customerimpact), wrangler logged in
  - [ ] 4.6 Owner: `npm run relay:keys` (signing key to Vercel + relay)
  - [ ] 4.5 Verify all tests pass

- [ ] 5. Phone from anywhere
  - [ ] 5.1 Write tests for relay-crypto and RelayClient
  - [ ] 5.2 X25519 keys, QR pairing over the account, AES-GCM frames
  - [ ] 5.3 RelayClient on the computer feeding PhoneService
  - [ ] 5.4 Phone UI transport switch; publish at gridhive.dev/app
  - [ ] 5.5 E2E test against wrangler dev; verify all tests pass
