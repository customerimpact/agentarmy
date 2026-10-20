# Database Schema

This is the database schema implementation for the spec detailed in @.agent-os/specs/2026-10-20-accounts-and-relay/spec.md

> Created: 2026-10-20
> Version: 1.0.0

Neon Postgres, created by migrations in `site/db/migrations/*.sql` (run with `npm run db:migrate` in site/).

## Changes

```sql
-- 001_waitlist.sql (already created on first signup by api/waitlist.js)
create table if not exists waitlist (
  email text primary key,
  source text,
  created_at timestamptz not null default now()
);

-- 002_auth.sql: the tables @auth/neon-adapter expects
create table users (
  id serial primary key,
  name text,
  email text unique,
  "emailVerified" timestamptz,
  image text
);
create table accounts (
  id serial primary key,
  "userId" integer not null references users(id) on delete cascade,
  type text not null,
  provider text not null,
  "providerAccountId" text not null,
  refresh_token text, access_token text, expires_at bigint,
  id_token text, scope text, session_state text, token_type text,
  unique (provider, "providerAccountId")
);
create table sessions (
  id serial primary key,
  "userId" integer not null references users(id) on delete cascade,
  expires timestamptz not null,
  "sessionToken" text not null unique
);
create table verification_token (
  identifier text not null,
  expires timestamptz not null,
  token text not null,
  primary key (identifier, token)
);

-- 003_devices.sql
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references users(id) on delete cascade,
  kind text not null check (kind in ('computer', 'phone')),
  name text not null,
  public_key text not null,          -- X25519, base64url; used by peers, not secret
  secret_hash text,                   -- sha256 of the computer's device secret
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create index devices_user on devices(user_id);

create table device_codes (
  device_code_hash text primary key,
  user_code text not null unique,     -- 8 chars, shown in the app
  name text not null,
  public_key text not null,
  user_id integer references users(id) on delete cascade,  -- set on confirm
  expires_at timestamptz not null
);
```

## Rationale

- Auth.js tables match the adapter's expected names so no custom adapter code is needed.
- Device secrets and codes are stored hashed; public keys are not secret.
- `on delete cascade` removes devices when an account is deleted (right to erasure).
