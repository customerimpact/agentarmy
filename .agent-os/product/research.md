# Research: Symvibe and how to build a free alternative

> Last Updated: 2026-10-17
> Sources: https://www.symvibe.com/, https://code.claude.com/docs/en/hooks, `claude --help` (v2.1.302)

## What Symvibe is

A native macOS app (Apple Silicon only, macOS 14+) that runs many AI coding CLI agents in
parallel as real terminals on a pan/zoom board. USD 19/month, no free trial. Formerly "Hypervibe".

### Feature inventory

| Area | Feature | In our MVP? |
| --- | --- | --- |
| Board | Each agent in a real PTY (Ctrl-C, Vim, htop work) | Yes |
| Board | Pan/zoom canvas of many consoles, positions remembered | Yes |
| Board | Workspaces switched like tabs | M2 |
| Board | Sticky notes, text, checklists, kanban | M2 |
| Board | Live localhost web tiles + inspector | M4 |
| Board | Ink/drawing, image markup | M4 |
| Board | Git branches + GitHub commit/push/pull panel | M4 |
| Orchestration | Mission map: working / resting / needs you (from CLI hooks) | Yes |
| Orchestration | Teams with roles, composer launching a team (up to 12) | M3 |
| Orchestration | Handoffs (summarize session, brief another agent) | M3 |
| Orchestration | Loops (schedule / idle / output trigger, goal-based retire) | M3 |
| Continuity | Consoles restored on reopen, resume last conversation | Yes |
| Continuity | Usage + token analytics from local session logs | M2 |
| Continuity | Two accounts of the same CLI | M5 |
| Continuity | Per-repo / global memory pushed to a console | M3 |
| Studios | Document, diagram, code, markdown studios | M4/M6 |
| Voice | On-device dictation, voice planner, spoken replies | M6 |
| Agents | 34 CLIs + custom executables | M5 (Claude Code only until then) |

### How Symvibe works technically (as published)

- forkpty per console, runs CLI binaries already on PATH, no API keys.
- Status comes from each CLI's own hooks.
- Resume uses each CLI's native resume.
- Usage read from local session logs.
- State saved as versioned JSON on disk.
- Paid cloud bits: Firebase auth, Groq (planner), Inworld (TTS), license check every 15 min.

## What the product videos show (watched frame by frame, 2026-10-17)

The site has 18 demo videos (`/media/*.av1.mp4`). The UI details below don't appear in the text:

- **Layout:** top bar has project picker, workspace tabs (+), "N live" counter and a usage-reset
  timer. A left tool rail holds: select, spawn Claude, duplicate, web tile, text, ink, eraser,
  globe, image, fit. A right rail holds: layers/mission map, checklist, settings, files, docs,
  memory, loops. The board background is dark with dots.
- **Bottom command bar** (central to the UX): quick chips "New console · Spawn 4 · Group ·
  Presets · Pause all · Resume all · Memory". Below them is a prompt input
  ("Hold space to speak · @ to direct…") that sends text to an @-mentioned console or group.
- **Console node:** header shows an agent icon, an auto-generated human name (Ada, Bex, Cy, Pip,
  Otto, Dax), a status pill (READY / WORKING / RUNNING), and restart/duplicate/close buttons.
  The body is the raw Claude Code TUI. Terminals stay live and readable down to ~50% zoom.
- **Groups:** a framed region with a title ("DOCS · 6 · 1 running", "REVIEWERS", "BACKEND")
  that auto-arranges its consoles in a grid. One prompt can go to every console in the group.
- **Compose group popover:** team name, role chips (Frontend, Backend, Testers, Reviewers,
  Design, Docs, Security, General), a grid of agent slots (Claude/Codex), "Fill all" with a CLI,
  a −/+ count, and a "Spawn N" button.
- **Orchestrator panel:** a list of all agents grouped by team with idle/running pills, plus a
  "Command 21 agents" input. "Connect" wires consoles to it, drawn as curved lines on the board.
- **Mission Map:** a modal graph (orchestrator → team → consoles) with filter chips
  (All / Working / Needs you / Idle / Done), search, a fleet-count side panel, and
  "Frame the team on the board".
- **Resume on reopen:** a toast "Resume all conversations? Yes / No". Each terminal prints
  "Claude lane restored — relaunching" and then "picking up your last chat".
- **Loops modal:** WHEN (on a schedule [5 min…2 h] / when an agent goes idle / when output
  contains…), TARGET (all consoles / pick consoles), STOP (after N runs / after time limit /
  when a goal is met, judged by a command or "an agent judges"), and a plain-English summary line.
- **Git panel:** repo/branch header, list of changed files, commit message box, push button,
  and recent commits.
- **Web tile:** a browser frame node showing a localhost page.
- **Drawing:** Excalidraw-style shape tools (stroke, fill, width, style, sloppiness, opacity)
  and a calendar widget node.
- **Usage panel:** token totals read from "local session logs".

**MVP takeaways:** add auto human names for consoles, a "Resume all?" prompt on startup, and a
bottom command bar that sends a prompt to the selected console. "To all"/groups follow in M3.
Excalidraw (MIT) is a good base for the M4 drawing tools.

## How we replicate it with Claude Code (verified mechanisms)

Everything the MVP needs is exposed by the Claude Code CLI itself:

1. **Real terminal**: spawn `claude` in a PTY (`node-pty`, which uses ConPTY on Windows and
   forkpty on macOS/Linux) and render with `xterm.js`.
2. **Stable identity**: `claude --session-id <uuid>` lets the app choose the session ID up front.
3. **Status without touching user config**: `claude --settings <file>` loads extra settings for
   that one process. We inject **HTTP hooks** pointing at a local server inside the app
   (`http://127.0.0.1:<port>/hook/<consoleId>`). Claude Code POSTs the event JSON there.
   Pass a temp file path, not inline JSON, to avoid Windows quoting problems.
4. **Status mapping**:

   | Hook event | Console status |
   | --- | --- |
   | `SessionStart` | idle (also re-read `session_id`; it changes on `/clear`) |
   | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | working |
   | `Notification` with `permission_prompt` / `elicitation_dialog` / `agent_needs_input` | needs you |
   | `Notification` with `idle_prompt` | resting / waiting for prompt |
   | `Stop` | done / resting |
   | `StopFailure` | error |
   | `SessionEnd` or PTY exit | exited |

5. **Restore on reopen**: persist `{cwd, sessionId, position, size}`; relaunch with
   `claude --resume <sessionId>` in the same cwd.
6. **Usage analytics**: parse `~/.claude/projects/<encoded-path>/<sessionId>.jsonl`
   (`transcript_path` is also in every hook payload) and sum `message.usage` tokens.
7. **Two accounts later**: set `CLAUDE_CONFIG_DIR` per console profile.
8. **Paid cloud features replaced for free**: planner, handoff summaries, studios and loop
   checks all run through `claude -p` on the user's own subscription. Dictation via local
   Whisper (whisper.cpp / transformers.js). No servers, no API keys, no license checks.

## Existing open-source tools (none is a clone)

- Vibe Kanban: kanban of tasks, each in a git worktree. Not a spatial terminal board.
- Claude Squad: TUI managing agents in tmux + worktrees. Terminal only, no canvas.
- Anthropic's own Claude Code desktop app (redesigned April 2026): multi-session sidebar,
  but proprietary, not a free canvas of real CLI terminals.

**Our gap to fill:** free, open source, cross-platform (Windows first — Symvibe has no
Windows or Intel Mac build), spatial board of real Claude Code terminals with hook-based status.

## Technical risks (to settle in the M0 spike)

1. **Blurry terminals when zoomed.** xterm's WebGL/canvas renderers blur under CSS
   `transform: scale`. Plan: semantic zoom. Live terminal at zoom >= ~0.75, a status card
   (name, status, last line) below that; refit the terminal when zoom settles.
2. **WebGL context limit.** Chromium allows roughly 16 WebGL contexts. Use the WebGL renderer
   only for the focused/visible consoles, DOM renderer for the rest.
3. **Windows spawning.** `claude` may be `claude.exe` or an npm `claude.cmd` shim; resolve the
   path, or spawn through `cmd.exe /c` / `pwsh -c`. Verify Ctrl-C passthrough under ConPTY.
4. **Many PTYs + rendering cost.** Pause rendering for off-screen consoles (keep buffering).
5. **Local server security.** A localhost server that can type into terminals is dangerous if any
   website can reach it. Bind 127.0.0.1, require a per-run token, check `Origin` and `Host`.
   (Shipping as a browser UI + `npx` package also removes code signing as a concern; see DEC-002.)

## Legal guardrails

Features and ideas are fair game. Do not copy Symvibe's name, logo, marketing copy, icons,
screenshots or code. Use our own name and visual design. License: MIT.
