# Product Roadmap

> Last Updated: 2026-10-20
> Version: 1.0.0
> Status: Planning

Brand (DEC-007): **GridHive**, gridhive.dev, `npx gridhive`.

Positioning (DEC-004): the control room for terminal agents. Vendor-neutral, local-first, on the subscriptions people already pay for. See @.agent-os/product/vision.md.

## Phase 0: Technical Spike (3-4 days)

**Goal:** Prove the risky parts work on Windows before building the product.
**Success Criteria:** A browser tab shows 2 live `claude` terminals inside React Flow nodes, zooming keeps text readable, and a hook POST changes a badge.

### Must-Have Features

- [x] Local server + Vite React scaffold - `npm run dev` starts server and UI with hot reload `XS`
- [x] node-pty spawns `claude` on Windows - Resolve `claude.exe`/`claude.cmd`, Ctrl-C works `S`
- [x] PTY over WebSocket to xterm.js inside a React Flow node - Typing, resize, scroll, pan and zoom `S`
- [x] Zoom rendering test - Semantic zoom vs refit, pick one; check WebGL context limits with 12 consoles `S`
- [x] HTTP hook round trip - `claude --session-id <uuid> --settings <tmpfile>` POSTs to the local server `XS`

### Dependencies

- Claude Code installed and logged in on the dev machine

## Phase 1: MVP v0.1 (2-3 weeks)

**Goal:** Daily-usable board for supervising several Claude Code agents, installable by anyone on Windows.
**Success Criteria:** You run 5+ agents on it for a full workday; a stranger runs `npx gridhive` and launches a console in under 2 minutes.

### Must-Have Features

- [x] Board - Infinite pan/zoom canvas, drag, resize, close consoles, minimap `M`
- [x] New console - Pick a folder, optional name, launches `claude` there `S`
- [x] Hook-driven status - Working / needs you / resting / error / exited badges and colored borders `M`
- [x] Mission list sidebar - All consoles with status; click to fly to and focus a console `S`
- [x] Needs-you notifications - Browser notification + tab title/favicon badge; clicking it focuses the console `S`
- [x] Persistence and resume - Save board to versioned JSON; on restart relaunch with `claude --resume <id>` `M`
- [x] Local security - 127.0.0.1 only, per-run token, Origin/Host checks `S`
- [ ] npm release - `npx gridhive` starts the server and opens the browser; README with install steps (package ready, not yet published) `S`

### Should-Have Features

- [x] CI on macOS and Linux - Same test matrix as Windows `S`
- [x] PWA window mode - Install as an app window, frees most browser shortcuts `XS`
- [x] Keyboard shortcuts - New console, cycle focus, zoom to fit, jump to next "needs you" `XS`
- [x] Command bar - Bottom prompt input that sends text to the selected console (@mention to pick) `S`
- [x] Auto names - Friendly agent names (Ada, Bex, Cy…) when none is given `XS`
- [x] "Resume all?" prompt - On startup, ask before relaunching saved conversations `XS`
- [x] Settings - Default shell, font size, theme (light/dark), launch flags for `claude` `S`

### Dependencies

- Phase 0 decisions on zoom rendering and Windows spawning

## Desktop Apps (parallel track)

**Goal:** An app window with tray, taskbar badge and auto-update, next to `npx gridhive` (DEC-003).
**Success Criteria:** Windows users install with one click, close the window and keep agents running, and get updates without reinstalling.

- [x] Windows desktop app - Electron wrapper, NSIS per-user installer, tray, taskbar badge, close-to-tray, Ctrl+Shift+A, auto-update from `desktop-v*` GitHub Releases `L`
- [ ] Windows code signing - Buy a certificate, set CSC_LINK / CSC_KEY_PASSWORD in CI, removes the SmartScreen warning `S`
- [ ] Windows arm64 build - Ship the win32-arm64 node-pty prebuild in a separate arm64 installer `S`
- [x] macOS app (unsigned) - Apple Silicon + Intel .dmg, ad-hoc signed, menu bar icon, Dock badge, login-shell PATH, "Download vX" update notice (DEC-006) `M`
- [ ] macOS signing + notarization - Apple Developer ID (USD 99/year); then hardened runtime and real auto-update `S`
- [ ] Linux AppImage/deb - Same Electron app, untested `S`

## Phase 2: Workspaces and Insight (2 weeks)

**Goal:** Organize many agents across projects and see what they cost.
**Success Criteria:** Users keep separate boards per project and can see token use per console.

### Must-Have Features

- [x] Workspaces - Multiple boards as tabs, each with its own consoles `M`
- [x] Notes, text and checklists - Board nodes beside consoles `S`
- [x] Usage analytics - Tokens per console/day from `~/.claude/projects/*.jsonl` `M`
- [x] Update notice - `npx gridhive` prints a line when npm has a newer version `XS`

### Should-Have Features

- [x] Git worktree per console - Optional isolated branch when creating a console `M`
- [x] Kanban node - Simple columns of cards on the board `S`

### Dependencies

- Phase 1 persistence format (add schema migrations)

## Phase 3: Orchestration (3 weeks)

**Goal:** Coordinate groups of agents instead of babysitting each one.
**Success Criteria:** One action launches a team of agents with roles; work can be handed from one agent to another.

### Must-Have Features

- [x] Teams and roles - Group frames that auto-grid their consoles, role prompt each, one prompt to the whole group `M`
- [x] Mission map - Graph view (team → consoles) with Working/Needs you/Idle/Done filters `M`
- [x] Pause all / Resume all - Send Esc to all working consoles; resume with a prompt `S`
- [x] Composer - Launch up to 12 consoles with roles and initial prompts in one step `M`
- [x] Handoffs - Summarize a session with `claude -p` from its transcript and send the brief to another console `M`
- [x] Loops - Re-send a prompt on schedule, on idle, or on output match; optional goal check that retires the loop `L`

### Should-Have Features

- [x] Project memory - Per-repo and global notes pushed into a console on demand `S`

### Dependencies

- Reliable status signals from Phase 1 (loops depend on idle detection)

## Phase 4: Board Power Tools (3 weeks)

**Goal:** Keep the whole dev loop on the board.
**Success Criteria:** Users preview, review and commit without leaving the app.

### Must-Have Features

- [x] Web tiles - Localhost preview nodes (live browser tiles + auto dev previews; DevTools not yet) `M`
- [x] Git panel - Branch, diff, commit, push, pull per repo `L`
- [x] Code viewer - File tree, syntax highlighting, pin files to the board `M`

### Should-Have Features

- [x] Ink tools - Draw and annotate on the board and on dropped images `M`
- [ ] Markdown notes vault - Linked notes with a graph view `L`
- [ ] Diagram and document studios - Generated via `claude -p`, export PNG/PDF `L`

### Dependencies

- Workspaces from Phase 2

## Phase 5: More Agents and Voice (3+ weeks)

**Goal:** Support other CLIs and hands-free control.
**Success Criteria:** Codex and Gemini CLI consoles show correct status; voice commands move the board.

### Must-Have Features

- [x] Agent adapter interface - Launch, resume, status and usage per CLI `M`
- [x] Codex, Gemini CLI, OpenCode adapters - Using their hooks or output heuristics `L`
- [x] Custom executable consoles - Any command, status from PTY activity only `S`
- [x] Multiple accounts - Profiles via `CLAUDE_CONFIG_DIR` `S`

### Should-Have Features

- [x] Local dictation - whisper.cpp / transformers.js, on-device `M`
- [ ] Voice planner - Spoken command to board actions via `claude -p`, confirm destructive actions `L`

### Dependencies

- Stable command/action layer from Phases 1-3

## Phase 6: Control Room Everywhere (4-6 weeks)

**Goal:** Your agents follow you: start, watch and answer them from your phone, and hand a session back and forth between computer and phone.
**Success Criteria:** A user launches a team from their phone, approves a "needs you" prompt from the lock screen and continues the same conversation on the computer without retyping anything.

### Must-Have Features

- [ ] Optional free account - GitHub or email sign-in on the website; the app keeps working fully without it (DEC-005) `M`
- [ ] Secure relay - The desktop app connects out to a relay with end-to-end encryption; the relay never sees terminal content or code `L`
- [ ] Phone app (PWA first) - Fleet list, live terminal view, needs-you approvals, push notifications `L`
- [x] Phone on this Wi-Fi (step before the relay) - Off by default; QR pairing with single-use codes, per-phone revocable tokens, allow-listed API on 0.0.0.0:4318. Fleet, live terminal, answer prompts, send messages `M`
- [x] Launch from your phone - Pick a project or team recipe on the phone; agents start on your computer and you monitor them there `M`
- [ ] Desktop ⇄ phone handoff, both ways (done on the same Wi-Fi; needs the relay to work from anywhere) - Move a running session to the phone and back (same session id, resumed in place), not one-way like Claude Code's remote control `L`

### Should-Have Features

- [x] Team recipes - Shareable link of roles, prompts, agents and models (gridhive.dev/r#code); import with a preview `S`
- [x] Share links and "Run in GridHive" badge - One click from a README or a post opens the recipe in the app `S`
- [ ] Recipe gallery - Public, community-submitted recipes with ratings, on the website `M`

### Dependencies

- Optional account and relay before phone features; recipe format before the gallery

## Phase 7: Review Lane and Autopilot (4 weeks)

**Goal:** Many agents produce many changes; make reviewing and steering them the easy part.
**Success Criteria:** All agents' changes land in one queue; a user reviews and merges 10 agents' work in under 15 minutes.

### Must-Have Features

- [ ] Review lane - One queue of every agent's diffs: AI pre-review, approve, merge, or send back with a comment `L`
- [ ] Project memory - Shared, versioned notes per project that every agent reads and updates `M`
- [ ] Triggers - Start a team from a GitHub issue or PR, a Slack message, or a schedule `M`

### Should-Have Features

- [ ] Plugin API - Third-party board nodes, agent adapters and triggers `L`
- [ ] Team plan (paid) - Shared boards, shared recipes and memory, usage across the team, SSO `L`

### Dependencies

- Git panel (Phase 4), loops (Phase 3), account (Phase 6) for team features

