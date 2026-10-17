# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private security advisories). Do not open a public issue.

Include:

- AgentArmy version, OS and Node version
- Steps to reproduce or a proof of concept
- What an attacker can achieve

We aim to acknowledge reports within 7 days and will keep you updated until a fix is released. We are happy to credit you in the advisory.

## Supported versions

Only the latest published version receives security fixes while the project is in 0.x.

## Scope

AgentArmy runs a local server that can start processes and send keystrokes to terminals on your machine. Its protections are:

- binding to `127.0.0.1` only
- a random per-run token required by the UI, the WebSocket and the hook endpoints
- rejecting requests with an unexpected `Origin` or `Host` header

In scope, for example:

- A web page, another origin or DNS rebinding reaching the server or WebSocket
- Bypassing or leaking the token (logs, referrers, error pages, files with loose permissions)
- Path traversal or arbitrary file access through the API (for example the folder picker)
- Command or argument injection when spawning `claude`
- AgentArmy writing to the user's Claude Code settings

Out of scope:

- Someone who already has the token URL or local access as your user
- Exposing the port yourself (tunnels, reverse proxies, port forwarding)
- Vulnerabilities in Claude Code itself; report those to Anthropic
- Actions an agent takes after you approve them in its own permission prompt
