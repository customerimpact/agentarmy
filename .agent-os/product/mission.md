# Product Mission

> Last Updated: 2026-10-20
> Version: 1.0.0

## Pitch

AgentArmy (working name) is the free, open-source control room for terminal coding agents: Claude Code, Codex, Gemini CLI, Grok and OpenCode run side by side in real terminals on one board, on the subscriptions developers already pay for, and you can launch, watch and approve them from your computer or your phone.

## Users

### Primary Customers

- Solo developers on Claude Code subscriptions: run several agents across repos without juggling terminal windows.
- Open-source community: people who want Symvibe-style orchestration for free, on Windows, Linux and Intel Macs too.

### User Personas

**Power vibe-coder** (25-45 years old)
- **Role:** Founder / freelance developer
- **Context:** Runs 3-10 Claude Code sessions at once across client projects
- **Pain Points:** Losing track of which session needs input, sessions lost after a reboot, paying for another subscription
- **Goals:** See every agent on one screen, get pinged when one needs approval, pick up where they left off

## The Problem

### Parallel agents are hard to supervise

Running several Claude Code sessions means a pile of terminal windows. Agents sit idle for minutes waiting on a permission prompt nobody saw.

**Our Solution:** A board of live terminals with hook-driven status badges and a notification when an agent needs you.

### Sessions don't survive a restart

Closing the terminal or rebooting loses the layout and makes you hunt for session IDs.

**Our Solution:** The board saves itself and relaunches each console with `claude --resume` in place.

### The existing tool is paid and Mac-only

Symvibe costs USD 19/month and only runs on Apple Silicon Macs.

**Our Solution:** MIT-licensed, free, cross-platform, Windows first.

## Differentiators

### Free and open source

Unlike Symvibe, there is no subscription, account, license check or cloud service. Everything runs on the user's existing Claude Code login.

### Cross-platform

Unlike Symvibe (Apple Silicon only), we ship Windows, macOS and Linux builds.

### No API keys, even for "smart" features

Planner, handoffs and summaries run through `claude -p` on the user's own subscription instead of paid third-party APIs.

## Key Features

### Core Features (MVP)

- **Board:** Infinite pan/zoom canvas; drag and resize consoles.
- **Real terminals:** Each console is a true PTY running `claude`.
- **Mission status:** Working / needs you / resting / exited badges from Claude Code hooks.
- **Mission list:** Sidebar of all consoles; click to fly to one.
- **Notifications:** Desktop notification when an agent needs input.
- **Restore:** Layout and conversations come back after closing the app.

### Later Features

- **Workspaces, notes, checklists:** Organize boards per project.
- **Usage analytics:** Token use per console from local logs.
- **Teams, handoffs, loops:** Launch and coordinate groups of agents.
- **Web tiles and git panel:** Preview localhost and commit from the board.
- **More CLIs:** Codex, Gemini CLI and custom executables.
- **Voice:** Local dictation and a voice planner.
