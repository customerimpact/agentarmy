# Spec Requirements Document

> Spec: Live sharing (share a board, see each other's cursors)
> Created: 2026-10-20
> Status: Proposal, waiting for the owner's choice of access levels

## Overview

A **Share** button (top right of the board) lets you invite people to follow your board live, with an access level you choose per person: watch, collaborate, or co-control. Everyone sees everyone's mouse pointer with their name, like Figma. The agents keep running on your computer; guests never get your logins, files or settings.

## Access levels

| Level | Sees the board live | Pointers + follow | Answer "needs you" | Type into agents | Notes, move things | Launch / close agents, templates |
| --- | --- | --- | --- | --- | --- | --- |
| **Viewer** | yes (terminals read-only) | yes | no | no | no | no |
| **Collaborator** | yes | yes | yes | only agents you hand over | yes | no |
| **Co-pilot** | yes | yes | yes | yes | yes | yes, in folders you allowed |

- **Hand over one agent:** right-click an agent → "Give keyboard to Tim" lets one Collaborator type into that agent until you take it back. Only one person types into an agent at a time; others see "Tim is typing".
- **Co-pilot** effectively runs commands on your computer. It needs an extra confirmation, can be limited in time, and only works for people with a GridHive account.
- Every guest action shows in your Actions history ("Tim answered Yes to Cy"), and **Pause sharing** freezes all guests at once.

## User Stories

### Show the team what the agents are doing

As a lead, I share my board as Viewer with two teammates. They open the link in a browser, see the agents work, follow my pointer while I explain, and point at things with their own pointers.

### Pair on a tricky agent

As a developer, I invite a colleague as Collaborator and hand them the keyboard of the Backend agent while I keep steering the rest.

### Run a shared team

As a small team, two founders give each other Co-pilot so either can launch, approve and steer agents on the shared machine.

## Spec Scope

1. **Share dialog** - Invite by email or copy a link; level per person; expiry (1 hour, 1 day, 7 days, until revoked); list of people with online status; revoke.
2. **Presence** - Avatars in the top bar, live pointers with names and colors, "Follow" (click an avatar and your view follows theirs), selection highlights.
3. **Guest board** - Guests open gridhive.dev/s/<id> in a browser (no install) or in their own GridHive app; same board UI with only what their level allows.
4. **Enforcement on the owner's computer** - Every guest action is checked against their level on the host, the same allow-list approach as phone access; nothing is trusted from the guest.
5. **End-to-end encryption** - Board data travels through the Cloudflare relay encrypted; the key sits in the invite link after "#", so neither the relay nor gridhive.dev can read terminals.

## Out of Scope

- Voice/video chat; editing files directly; shared boards that run in the cloud without the owner's computer.

## Expected Deliverable

1. Owner clicks Share, picks Viewer, sends the link; the guest sees the board live within 2 seconds, with both pointers visible on both screens.
2. A Viewer cannot answer prompts or type (UI hidden, and the host refuses it); a Collaborator can answer prompts and type only into handed-over agents.
3. Revoking or pausing removes guest access immediately.

## Technical notes

```
guest browser/app ──wss (E2E)──► Cloudflare relay ◄──wss (E2E)── owner's GridHive app (source of truth)
       ▲                                                              │ checks level on every action
gridhive.dev: shares table (id, owner, invitees, level, expiry, revoked) ─┘ relay tokens carry share id + level
```

- Pointers: board coordinates, sent at most 20 times a second, through the relay to everyone in the share.
- Builds on: account linking (done), relay (done), relay client in the app (next), phone UI transport switch.

## Phases

1. **Viewer + pointers + follow** (link sharing, signed-in guests, expiry, revoke).
2. **Collaborator** (answer prompts, hand over one agent, notes, Actions history of guest actions).
3. **Co-pilot + email invites + team billing** (the paid Team plan from the roadmap).
