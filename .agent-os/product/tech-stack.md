# Technical Stack

> Last Updated: 2026-10-17
> Version: 1.0.0

This is a local web app (browser UI + local Node server), so it overrides the global Rails/Postgres defaults (see DEC-002).

- **Application framework:** Node 22 local server (TypeScript, Fastify + WebSocket) + browser UI
- **Build tooling:** Vite (UI), tsup (server); one npm package
- **Database system:** None. Versioned JSON files in `~/.agentarmy/`
- **JavaScript framework:** React (latest stable)
- **Import strategy:** node (npm, Node 22 LTS)
- **CSS framework:** TailwindCSS 4
- **UI component library:** shadcn/ui (Radix primitives)
- **Board / canvas:** @xyflow/react (React Flow, MIT)
- **Terminal emulator:** @xterm/xterm + addons (fit, webgl, web-links, unicode11)
- **PTY:** node-pty (ConPTY on Windows, forkpty on macOS/Linux)
- **State:** Zustand
- **Terminal transport:** WebSocket per console between browser xterm.js and server PTY
- **Hook receiver:** Same local server, `/hook/<consoleId>` route
- **Local security:** Bind 127.0.0.1 only, random per-run token in the URL/WebSocket, reject foreign `Origin`/`Host` headers (stops other websites and DNS rebinding from driving your terminals)
- **Fonts provider:** Self-hosted (JetBrains Mono for terminals, Inter for UI)
- **Icon library:** Lucide (React)
- **Tests:** Vitest (unit), Playwright (end-to-end in the browser)
- **Distribution:** npm package, run with `npx agentarmy` (starts server, opens browser)
- **App-like window (optional):** installable PWA so it gets its own window and fewer browser shortcut clashes
- **Application hosting:** n/a (runs locally)
- **Database hosting:** n/a
- **Asset hosting:** npm registry
- **Deployment solution:** GitHub Actions: test on windows/macos/ubuntu, `npm publish` on tag push
- **Code repository URL:** https://github.com/customerimpact/agentarmy (public, MIT)
