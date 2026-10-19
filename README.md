# AgentArmy

Run many Claude Code agents in parallel, each in a real terminal, on one pan-and-zoom board in your browser.

![AgentArmy board with several Claude Code consoles](docs/screenshot.png)

<!-- TODO: add docs/screenshot.png (or a short GIF) once the MVP UI is in place. -->

> Status: early development (v0.x). Expect rough edges and breaking changes.

## Why

- **Free and open source.** MIT license. No subscription, no license check.
- **Windows, macOS and Linux.** Windows is a first-class target, not an afterthought.
- **No account, no API keys.** It drives the `claude` CLI you already have, on your own Claude Code login.
- **Nothing in the cloud.** A local server on your machine; the UI is a browser tab.

## Features

MVP (v0.1) scope:

- **Board** - infinite pan/zoom canvas; drag, resize and close consoles; minimap.
- **Real terminals** - every console is a true PTY running `claude` in the folder you pick.
- **Hook-driven status** - each console shows *working*, *needs you*, *resting*, *error* or *exited*, reported by Claude Code hooks rather than guessed from output.
- **Mission list** - a sidebar of all consoles and their status; click one to fly to it.
- **Needs-you notifications** - browser notification plus a tab title badge when an agent is waiting on you; click to focus that console.
- **Restore and resume** - the board is saved; after a restart each console relaunches with `claude --resume` in the same place.

## Requirements

- Node.js 20 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, on your `PATH`, and logged in (run `claude` once in a terminal first)

## Quick start

```sh
npx agentarmy
```

This starts the local server and opens the board in your default browser.

| Option | Default | Description |
| --- | --- | --- |
| `--port <n>` | `4317` | Port for the local server |
| `--no-open` | off | Do not open the browser; the URL (with token) is printed in the terminal |

Keep the terminal running `npx agentarmy` open. Stopping it (Ctrl-C) stops the server and the consoles; they come back the next time you start it.

## Desktop app (Windows)

Prefer a real app window over a browser tab? The Windows desktop app runs the same server and board in its own window, with no browser shortcut clashes.

1. Download `AgentArmy-Setup-<version>.exe` from the [releases page](https://github.com/customerimpact/agentarmy/releases) (tags `desktop-v*`).
2. Run it. It installs for your user only (no admin prompt) and adds Start menu and desktop shortcuts.
3. The installer is **not code-signed yet**, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.

What the desktop app adds:

- **Tray icon.** Closing the window keeps your agents running in the tray. The tray shows how many agents need you, lists them (click one to fly to it), and has Pause notifications 1 h, Start with Windows, Check for updates and Quit.
- **Taskbar badge and flash** when an agent needs you, and native Windows notifications.
- **Ctrl+Alt+A** shows or hides the window from anywhere.
- **Auto-update** from GitHub Releases: checked at start and every 6 hours, downloaded in the background, installed when you choose "Restart to update" or quit. This is the only network call the app makes itself.
- **Quit** asks first when agents are running. They stop and can be resumed next time, like Ctrl-C on `npx agentarmy`.

The app and `npx agentarmy` share the same board (`~/.agentarmy`). If `npx agentarmy` is already running, the app opens that board instead of starting a second server.

Build it yourself (Windows, Node 22):

```sh
npm install
npm run desktop:dev     # build and run the app from the repo
npm run desktop:build   # unpacked app in release/win-unpacked
npm run desktop:dist    # installer: release/AgentArmy-Setup-<version>.exe
npm run test:desktop    # Playwright smoke test (set DESKTOP_EXE to test a packaged build)
```

Releases: push a tag `desktop-v<version>` (matching `package.json`) and `.github/workflows/desktop.yml` builds the installer and attaches it, with `latest.yml` for auto-update, to a draft GitHub Release. To sign builds, set `CSC_LINK` (the `.pfx` certificate, as a path, URL or base64) and `CSC_KEY_PASSWORD` for electron-builder. macOS and Linux builds are not available yet.

## How it works

- **One PTY per console.** The server uses [node-pty](https://github.com/microsoft/node-pty) (ConPTY on Windows) to start `claude` in the chosen folder. The browser renders it with xterm.js over a WebSocket.
- **Status via HTTP hooks.** Each console is started as `claude --session-id <uuid> --settings <temp file>`. The temp settings file adds Claude Code [HTTP hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) that POST events (session start, prompt submitted, notification, stop) to the local server. Your own `~/.claude` settings are never modified.
- **State on disk.** Board layout and console list are stored in `~/.agentarmy/state.json`.
- **Resume.** On restart, each console is relaunched with `claude --resume <session id>`, so the conversation continues where it stopped.

## Security model

AgentArmy gives a browser tab the ability to type into terminals on your machine, so it is locked down:

- The server binds to `127.0.0.1` only. It is not reachable from your network.
- Each run generates a random token. The UI, the WebSocket and the hook endpoints all require it.
- Requests with a foreign `Origin` or `Host` header are rejected, which blocks other websites and DNS rebinding attacks.

**Anyone who has the URL with the token can type into your terminals.** Do not share it, paste it in chats or screenshots, or expose the port through a tunnel or proxy.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `N` | New agent (when no terminal has focus) |
| `F` | Fit all consoles in view |
| `Alt+]` / `Alt+[` | Focus next / previous console |
| `Alt+J` | Jump to the next console that needs you |

## Roadmap

See [.agent-os/product/roadmap.md](.agent-os/product/roadmap.md) for details.

- **Phase 1 - MVP v0.1:** board, status, notifications, restore, `npx` release.
- **Phase 2 - Workspaces and insight:** multiple boards, notes, token usage per console.
- **Phase 3 - Orchestration:** teams, composer, handoffs between agents, loops.
- **Phase 4 - Board power tools:** localhost preview tiles, git panel, code viewer.
- **Phase 5 - More agents and voice:** Codex, Gemini CLI and custom commands; local dictation.

## Development

```sh
npm install
npm run dev      # server on http://127.0.0.1:4317 + Vite dev server on :5173
npm test         # Vitest
npm run typecheck
npm run build    # Vite (UI) + tsup (server) into dist/
```

`node-pty` is a native module. If `npm install` fails to build it, install your platform's build tools (Visual Studio Build Tools with the C++ workload on Windows, Xcode Command Line Tools on macOS, `build-essential` and `python3` on Linux).

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## FAQ

**Why a browser tab and not a desktop app?**
Both exist. A browser UI plus a local server installs with one command, needs no installer or code signing, and works the same on every OS. On Windows you can also use the [desktop app](#desktop-app-windows), which wraps the same server and UI in its own window with a tray icon.

**Why not tmux?**
tmux is great if you live in it. AgentArmy adds what tmux does not have: status from Claude Code hooks, notifications when an agent waits on you, a spatial layout you can zoom out of, and one-click resume. It also works on Windows without WSL.

**Does it change my Claude Code settings?**
No. Hooks are passed per console through a temporary `--settings` file. Nothing in `~/.claude` is written.

**Does it auto-approve permissions?**
No. Each `claude` keeps its own permission prompts. AgentArmy only tells you when one is waiting.

**Does it send my code anywhere?**
AgentArmy itself makes no network calls beyond your machine (the desktop app only checks GitHub Releases for updates). The `claude` processes talk to Anthropic exactly as they would in a normal terminal.

## License

[MIT](LICENSE). The code is MIT; the AgentArmy name and logo are not, see [TRADEMARKS.md](TRADEMARKS.md) (forks need their own name). Contributions require accepting the [CLA](CLA.md); a bot asks on your first pull request.

AgentArmy runs entirely on your computer and sends no data to its authors; see the [privacy notice](https://agentarmy-site.vercel.app/privacy). Use it within the [terms that apply to your Claude account](https://www.anthropic.com/legal); in particular, don't use extra accounts to get around usage limits.

AgentArmy is an independent community project. It is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
