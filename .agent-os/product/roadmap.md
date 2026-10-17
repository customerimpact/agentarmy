# Product Roadmap

> Last Updated: 2026-10-17
> Version: 1.0.0
> Status: Planning

Claude Code is the only supported agent until Phase 5.

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
**Success Criteria:** You run 5+ agents on it for a full workday; a stranger runs `npx agentarmy` and launches a console in under 2 minutes.

### Must-Have Features

- [x] Board - Infinite pan/zoom canvas, drag, resize, close consoles, minimap `M`
- [x] New console - Pick a folder, optional name, launches `claude` there `S`
- [x] Hook-driven status - Working / needs you / resting / error / exited badges and colored borders `M`
- [x] Mission list sidebar - All consoles with status; click to fly to and focus a console `S`
- [x] Needs-you notifications - Browser notification + tab title/favicon badge; clicking it focuses the console `S`
- [x] Persistence and resume - Save board to versioned JSON; on restart relaunch with `claude --resume <id>` `M`
- [x] Local security - 127.0.0.1 only, per-run token, Origin/Host checks `S`
- [ ] npm release - `npx agentarmy` starts the server and opens the browser; README with install steps (package ready, not yet published) `S`

### Should-Have Features

- [ ] CI on macOS and Linux - Same test matrix as Windows `S`
- [ ] PWA window mode - Install as an app window, frees most browser shortcuts `XS`
- [x] Keyboard shortcuts - New console, cycle focus, zoom to fit, jump to next "needs you" `XS`
- [x] Command bar - Bottom prompt input that sends text to the selected console (@mention to pick) `S`
- [x] Auto names - Friendly agent names (Ada, Bex, Cy…) when none is given `XS`
- [x] "Resume all?" prompt - On startup, ask before relaunching saved conversations `XS`
- [ ] Settings - Default shell, font size, theme (light/dark), launch flags for `claude` `S`

### Dependencies

- Phase 0 decisions on zoom rendering and Windows spawning

## Phase 2: Workspaces and Insight (2 weeks)

**Goal:** Organize many agents across projects and see what they cost.
**Success Criteria:** Users keep separate boards per project and can see token use per console.

### Must-Have Features

- [ ] Workspaces - Multiple boards as tabs, each with its own consoles `M`
- [ ] Notes, text and checklists - Board nodes beside consoles `S`
- [ ] Usage analytics - Tokens per console/day from `~/.claude/projects/*.jsonl` `M`
- [ ] Update notice - Tell the user when a newer npm version exists `XS`

### Should-Have Features

- [ ] Git worktree per console - Optional isolated branch when creating a console `M`
- [ ] Kanban node - Simple columns of cards on the board `S`

### Dependencies

- Phase 1 persistence format (add schema migrations)

## Phase 3: Orchestration (3 weeks)

**Goal:** Coordinate groups of agents instead of babysitting each one.
**Success Criteria:** One action launches a team of agents with roles; work can be handed from one agent to another.

### Must-Have Features

- [ ] Teams and roles - Group frames that auto-grid their consoles, role prompt each, one prompt to the whole group `M`
- [ ] Mission map - Graph view (team → consoles) with Working/Needs you/Idle/Done filters `M`
- [ ] Pause all / Resume all - Send Esc to all working consoles; resume with a prompt `S`
- [ ] Composer - Launch up to 12 consoles with roles and initial prompts in one step `M`
- [ ] Handoffs - Summarize a session with `claude -p` from its transcript and send the brief to another console `M`
- [ ] Loops - Re-send a prompt on schedule, on idle, or on output match; optional goal check that retires the loop `L`

### Should-Have Features

- [ ] Project memory - Per-repo and global notes pushed into a console on demand `S`

### Dependencies

- Reliable status signals from Phase 1 (loops depend on idle detection)

## Phase 4: Board Power Tools (3 weeks)

**Goal:** Keep the whole dev loop on the board.
**Success Criteria:** Users preview, review and commit without leaving the app.

### Must-Have Features

- [ ] Web tiles - Localhost preview nodes with DevTools `M`
- [ ] Git panel - Branch, diff, commit, push, pull per repo `L`
- [ ] Code viewer - File tree, syntax highlighting, pin files to the board `M`

### Should-Have Features

- [ ] Ink tools - Draw and annotate on the board and on dropped images `M`
- [ ] Markdown notes vault - Linked notes with a graph view `L`
- [ ] Diagram and document studios - Generated via `claude -p`, export PNG/PDF `L`

### Dependencies

- Workspaces from Phase 2

## Phase 5: More Agents and Voice (3+ weeks)

**Goal:** Support other CLIs and hands-free control.
**Success Criteria:** Codex and Gemini CLI consoles show correct status; voice commands move the board.

### Must-Have Features

- [ ] Agent adapter interface - Launch, resume, status and usage per CLI `M`
- [ ] Codex, Gemini CLI, OpenCode adapters - Using their hooks or output heuristics `L`
- [ ] Custom executable consoles - Any command, status from PTY activity only `S`
- [ ] Multiple accounts - Profiles via `CLAUDE_CONFIG_DIR` `S`

### Should-Have Features

- [ ] Local dictation - whisper.cpp / transformers.js, on-device `M`
- [ ] Voice planner - Spoken command to board actions via `claude -p`, confirm destructive actions `L`

### Dependencies

- Stable command/action layer from Phases 1-3
