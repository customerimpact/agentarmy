# Spec Requirements Document

> Spec: Accounts and phone relay (GridHive from anywhere)
> Created: 2026-10-20
> Status: Planning

## Overview

Let people create a free GridHive account (GitHub, Google or an email link) and use their phone with their computer from anywhere, not only on the same Wi-Fi. The app keeps working fully without an account (DEC-005), and the relay never sees terminal content (end-to-end encrypted).

## User Stories

### Approve an agent from the train

As a developer away from my desk, I want my phone to show my running agents and let me answer a permission prompt, so that my agents do not sit idle until I am back.

The desktop app is signed in and connected to the relay. The phone opens gridhive.dev/app, is already linked to the account, sees the fleet, opens the agent that needs approval and taps "Yes". The answer travels encrypted through the relay to the computer.

### Launch at home, follow on the phone, finish at the desk

As a developer, I want to start a team from my phone, watch it on my computer, and move any session between the two in both directions.

Same flows as phone-on-Wi-Fi (launch, "On computer", "Continue on phone"), now over the relay.

### Join the waitlist today

As a visitor of gridhive.dev, I want to leave my email for early access, so that I hear when "from anywhere" is ready.

## Spec Scope

1. **Waitlist** - "Get early access" form on gridhive.dev stores the email in Neon (one row per email, honeypot against bots).
2. **Accounts** - Sign in on gridhive.dev with GitHub, Google or an email link (Resend); users, sessions and accounts in Neon.
3. **Link a computer** - Desktop app or `npx gridhive` shows "Sign in to GridHive"; a device-code flow links it to the account without the app ever seeing a password.
4. **Relay** - Cloudflare Worker with one Durable Object per account forwards encrypted frames between the account's computers and phones over WebSockets.
5. **Phone app from anywhere** - gridhive.dev/app is the same phone UI as on Wi-Fi, talking through the relay; pairing a phone to a computer exchanges keys once (QR on the computer).

## Out of Scope

- Paid Team plan, shared boards, SSO (Phase 7)
- Native iOS/Android apps and lock-screen push (ntfy stays the alert channel; web push later)
- Syncing boards or code to the cloud

## Expected Deliverable

1. A visitor joins the waitlist on gridhive.dev and the email appears once in Neon.
2. A signed-in user links the desktop app, scans the QR with a phone on mobile data, sees the fleet and answers a prompt; the relay logs show only ciphertext sizes.
3. Signing out on the website or removing the phone stops relay access immediately; the app keeps working locally.

## Spec Documentation

- Tasks: @.agent-os/specs/2026-10-20-accounts-and-relay/tasks.md
- Technical Specification: @.agent-os/specs/2026-10-20-accounts-and-relay/sub-specs/technical-spec.md
- API Specification: @.agent-os/specs/2026-10-20-accounts-and-relay/sub-specs/api-spec.md
- Database Schema: @.agent-os/specs/2026-10-20-accounts-and-relay/sub-specs/database-schema.md
- Tests Specification: @.agent-os/specs/2026-10-20-accounts-and-relay/sub-specs/tests.md
