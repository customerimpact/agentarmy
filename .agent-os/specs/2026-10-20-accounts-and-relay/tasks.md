# Spec Tasks

These are the tasks to be completed for the spec detailed in @.agent-os/specs/2026-10-20-accounts-and-relay/spec.md

> Created: 2026-10-20
> Status: Ready for Implementation

## Tasks

- [ ] 1. Waitlist on gridhive.dev
  - [x] 1.1 Write tests for the waitlist handler
  - [x] 1.2 POST /api/waitlist on Vercel with Neon (honeypot, one row per email)
  - [ ] 1.3 "Get early access" form on the homepage (after the Kaizo-palette restyle)
  - [ ] 1.4 Privacy notice: waitlist emails, how to be removed
  - [ ] 1.5 Owner: add Neon to the Vercel project; point gridhive.dev to Vercel
  - [ ] 1.6 Verify a signup lands in Neon on the live site

- [ ] 2. Accounts (Auth.js on Vercel, Neon adapter)
  - [ ] 2.1 Write tests for session and sign-in routes (test provider)
  - [ ] 2.2 Migrations 002_auth.sql
  - [ ] 2.3 GitHub, Google and Resend providers; sign-in and account pages
  - [ ] 2.4 Owner: OAuth apps and Resend domain, env vars in Vercel
  - [ ] 2.5 Verify all tests pass

- [ ] 3. Link a computer (device code flow)
  - [ ] 3.1 Write tests for codes, polling and secrets
  - [ ] 3.2 /api/devices/* and gridhive.dev/link page
  - [ ] 3.3 "Sign in to GridHive" in Settings (desktop app and npx)
  - [ ] 3.4 Verify all tests pass

- [ ] 4. Cloudflare relay
  - [ ] 4.1 Write Durable Object tests (vitest-pool-workers)
  - [ ] 4.2 Worker + DO, Ed25519 token check, limits, presence, revoke
  - [ ] 4.3 /api/relay/token on Vercel
  - [ ] 4.4 Owner: Cloudflare account, `wrangler login`, relay.gridhive.dev
  - [ ] 4.5 Verify all tests pass

- [ ] 5. Phone from anywhere
  - [ ] 5.1 Write tests for relay-crypto and RelayClient
  - [ ] 5.2 X25519 keys, QR pairing over the account, AES-GCM frames
  - [ ] 5.3 RelayClient on the computer feeding PhoneService
  - [ ] 5.4 Phone UI transport switch; publish at gridhive.dev/app
  - [ ] 5.5 E2E test against wrangler dev; verify all tests pass
