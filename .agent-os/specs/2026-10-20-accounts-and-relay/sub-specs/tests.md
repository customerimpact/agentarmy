# Tests Specification

This is the tests coverage details for the spec detailed in @.agent-os/specs/2026-10-20-accounts-and-relay/spec.md

> Created: 2026-10-20
> Version: 1.0.0

## Test Coverage

### Unit Tests

**Waitlist (site/api/_waitlist.js)** - done
- Valid email stored once, lowercased, with a clean source tag
- Bad emails rejected, honeypot ignored silently

**Device linking**
- Codes expire, are single use, user codes have no look-alike characters
- Token poll returns pending, then the secret once, then 410

**Relay tokens**
- Signed and verified with Ed25519; expired or tampered tokens rejected

**E2E crypto (src/shared/relay-crypto.ts)**
- Round trip phone → computer; wrong key, replayed nonce or swapped sender id fails

**Relay Durable Object (Miniflare / vitest-pool-workers)**
- Forwards only within one account, enforces frame size and rate limits, presence updates, revoke closes the socket

### Integration Tests

**RelayClient ↔ PhoneService**
- An encrypted `/m/api/state` call over a fake relay returns the board state; non-allow-listed paths stay 404

### Feature Tests (Playwright)

- Waitlist form on the site: success message, invalid email message
- Phone page with the relay transport against a local Worker (wrangler dev): pair, answer a prompt, handoff both ways

### Mocking Requirements

- **Neon:** fake tagged-template `sql` in unit tests; a Neon branch for preview deployments
- **OAuth providers:** Auth.js test provider in e2e; never real GitHub/Google accounts in CI
- **Resend:** captured in memory in tests
