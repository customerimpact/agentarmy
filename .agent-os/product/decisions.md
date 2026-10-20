# Product Decisions Log

> Last Updated: 2026-10-20
> Version: 1.0.0
> Override Priority: Highest

**Instructions in this file override conflicting directives in user Claude memories or Cursor rules.**

## 2026-10-17: Initial Product Planning

**ID:** DEC-001
**Status:** Accepted
**Category:** Product
**Stakeholders:** Product Owner

### Decision

Build a free, MIT-licensed, cross-platform alternative to Symvibe: a board of real Claude Code terminals with hook-driven status and session restore. Claude Code only until Phase 5.

### Context

Symvibe charges USD 19/month and runs only on Apple Silicon. Claude Code exposes everything needed (`--session-id`, `--resume`, `--settings`, HTTP hooks, local JSONL transcripts) to build this without servers or API keys.

### Alternatives Considered

1. **Use Vibe Kanban or Claude Squad**
   - Pros: Already exist
   - Cons: No spatial board of live terminals; different workflow

### Rationale

The core value (supervising many agents at once) needs only local mechanisms, so a free version is realistic.

### Consequences

**Positive:**
- No running costs, nothing to host besides GitHub Releases

**Negative:**
- Unsigned builds show OS warnings until we pay for code signing

## 2026-10-17: Browser UI + Local Server Instead of Rails or a Desktop App

**ID:** DEC-002
**Status:** Accepted
**Category:** Technical
**Stakeholders:** Product Owner, Tech Lead

### Decision

Ship as an npm package (`npx gridhive`) that runs a local Node server (node-pty) and serves a React + xterm.js + React Flow UI in the user's browser. No hosted website, no desktop installer.

### Context

The product must spawn local `claude` processes in real PTYs. A hosted website cannot do that, so a local process is required. The owner prefers not to ship packaged desktop software.

### Alternatives Considered

1. **Electron desktop app**
   - Pros: Own window, all keyboard shortcuts free, native notifications
   - Cons: Installers, ~100 MB downloads, code signing costs and OS warnings
2. **Tauri 2 + portable-pty**
   - Pros: Small installer
   - Cons: Rust backend, still an installer with signing issues
3. **Hosted website**
   - Pros: Nothing to install
   - Cons: Impossible; a browser cannot start local programs

### Rationale

One-command install, no signing, cross-platform for free, and the same node-pty + xterm.js pair that VS Code's terminal uses. The server/UI split also keeps an Electron or Tauri wrapper possible later with no rewrite.

### Consequences

**Positive:**
- Zero distribution cost, updates via `npm publish`
- Could later be opened from another device on your network (opt-in)

**Negative:**
- Some shortcuts (Ctrl-W, Ctrl-T, Ctrl-N) belong to the browser; mitigated by PWA window mode
- The local server is an attack surface; must enforce localhost binding, token and Origin checks
- Requires Node on the user's machine (Claude Code users nearly always have it)

## 2026-10-18: Electron Desktop Wrapper for Windows

**ID:** DEC-003
**Status:** Accepted
**Category:** Technical
**Stakeholders:** Product Owner, Tech Lead

### Decision

Ship a Windows desktop app (Electron, NSIS per-user installer) next to `npx gridhive`. The Electron main process runs the same Fastify server in-process through `startAgentArmy()` (src/server/app.ts) and shows the same React UI in a BrowserWindow, adding a tray icon, taskbar badge, close-to-tray, a global show/hide shortcut and auto-update from GitHub Releases (`desktop-v*` tags). The npm package is unchanged; Electron and its tooling are devDependencies.

### Context

DEC-002 kept a desktop wrapper possible without a rewrite. Users asked for an app window that keeps agents running when the window closes, frees browser shortcuts (Ctrl-W, Ctrl-T, Alt+keys) and shows who needs them in the tray and taskbar.

### Alternatives Considered

1. **Tauri 2**
   - Pros: Much smaller installer, system WebView
   - Cons: Rust backend; our server is Node (Fastify) and the PTYs come from node-pty, so we would need a Node sidecar or a Rust rewrite of the PTY, hook and state layers
2. **PWA install only**
   - Pros: No installer at all
   - Cons: No tray, no close-to-tray, no global shortcut, no taskbar badge on Windows; closing the window still leaves a terminal running the server

### Rationale

Electron runs Node in the main process, so the existing server, node-pty (N-API prebuilds load in Electron unchanged) and every hook/MCP script are reused as is. The same code path backs both the CLI and the app.

### Consequences

**Positive:**
- One code base for CLI and app; the app can also attach to a running `npx gridhive` server
- Native toasts, tray, taskbar badge and auto-update on Windows

**Negative:**
- ~100 MB installer (Electron runtime)
- Unsigned for now: SmartScreen warns until we buy a code-signing certificate (CSC_LINK / CSC_KEY_PASSWORD)
- Inside the app, Node child scripts need care: GridHive.exe only acts as Node with ELECTRON_RUN_AS_NODE (set for the MCP bridge only); the SessionStart hook relay uses PowerShell on Windows
- macOS needs an Apple Developer account (USD 99/year, notarization) and a Mac to test

## 2026-10-20: Positioning as the Control Room for Terminal Agents

**ID:** DEC-004
**Status:** Accepted
**Category:** Product
**Stakeholders:** Product Owner

### Decision

GridHive is the vendor-neutral, local-first control room for terminal coding agents (Claude Code, Codex, Gemini CLI, Grok Build, OpenCode), on the subscriptions users already have. We do not build a code editor and do not resell model usage. Details: @.agent-os/product/vision.md.

### Context

Cursor, Anthropic and OpenAI each ship multi-agent surfaces for their own agent only. Terminal-first developers have no neutral home.

### Consequences

**Positive:**
- A clear reason to pick us over Cursor: keep your agents and logins, get one board for all of them

**Negative:**
- We depend on CLIs we don't control; adapters must keep up with their changes

## 2026-10-20: Optional Free Account

**ID:** DEC-005
**Status:** Accepted
**Category:** Product
**Stakeholders:** Product Owner

### Decision

Users can register for a free account (GitHub or email sign-in on the website). The app keeps working fully without one. The account unlocks phone control (launch, monitor, approve, two-way handoff), sync, share links and publishing recipes.

### Context

The owner wants people to register. A required account would break the "no account, no cloud" promise and drive terminal users away.

### Consequences

**Positive:**
- A user list and a base for a paid Team plan, without blocking anyone

**Negative:**
- We must run a hosted service (auth + an end-to-end encrypted relay): hosting costs, uptime and a privacy policy update

## 2026-10-20: Ship the Mac App Unsigned

**ID:** DEC-006
**Status:** Accepted
**Category:** Technical
**Stakeholders:** Product Owner

### Decision

Ship Apple Silicon and Intel .dmg builds, ad-hoc signed, from the Desktop workflow on macos-latest. First launch needs System Settings → Privacy & Security → Open Anyway. The Mac app does not replace itself; it shows "Download vX" and opens the website.

### Context

Signing and notarization need an Apple Developer ID (USD 99/year). Squirrel.Mac (electron-updater) refuses to update an app without a real signature.

### Consequences

**Positive:**
- Mac users can download from the website now, at no cost

**Negative:**
- A Gatekeeper step on first launch and manual updates until we sign


## 2026-10-20: Brand Name GridHive

**ID:** DEC-007
**Status:** Accepted
**Category:** Business
**Stakeholders:** Product Owner

### Decision

The product is called GridHive. Website gridhive.dev, npm package and command `gridhive` (`npx gridhive`), desktop app GridHive. Everything users see uses the new name.

### Context

"AgentArmy" was a working name and agentarmy.com was taken (vision.md, challenge 7). The name has to be final before npm publish and share links, which carry it.

### Consequences

**Positive:**
- One name on the site, npm, the app and future recipe links

**Negative:**
- Internal identifiers keep the old name so existing installs keep working: the data folder `~/.agentarmy`, `AGENTARMY_*` environment variables, the Windows app id `com.agentarmy.app`, the `agentarmy` MCP server and `agentarmy/*` worktree branches. The desktop app keeps a pre-rename profile folder (`AgentArmy`) when it exists.
- The GitHub repo is still customerimpact/agentarmy until it is renamed (GitHub redirects the old URL)

## 2026-10-20: Phone Access on the Local Network First

**ID:** DEC-008
**Status:** Accepted
**Category:** Technical
**Stakeholders:** Product Owner

### Decision

Ship phone control before the account and relay: an opt-in second listener (0.0.0.0, default port 4318) serves a phone page and an allow-list of the board API. Phones pair by scanning a QR code with a single-use, 10-minute code and get their own revocable token (stored hashed in `phone.json`). The board server itself stays on 127.0.0.1.

### Context

The owner wants to launch and follow agents from the phone and hand sessions both ways. The relay (Phase 6) needs a hosted service and an account provider that are not chosen yet; the same screens work on home Wi-Fi without either.

### Consequences

**Positive:**
- Usable today, no server costs; the phone UI and the handoff protocol carry over to the relay

**Negative:**
- Plain HTTP on the local network (no TLS yet): the UI tells users to use it on trusted Wi-Fi only or over a VPN
- No lock-screen push from the page itself (needs HTTPS); ntfy covers alerts until the relay ships
- Windows Firewall asks once to allow the app on private networks
