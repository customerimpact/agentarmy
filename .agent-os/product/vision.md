# Vision: the control room for terminal agents

> Last Updated: 2026-10-20
> Status: Accepted by the product owner (DEC-004, DEC-005, DEC-006)

## Where agentic building is going

- Developers stop typing code and start supervising agents. The scarce resource becomes attention:
  who needs me, what changed, is it good, what next.
- The strongest agents are terminal CLIs (Claude Code, Codex, Gemini CLI, Grok Build, OpenCode).
  Senior developers increasingly live in the terminal, not in an editor.
- Every vendor builds its own multi-agent surface, but only for its own agent:
  Cursor Projects (coordinator + parallel agents, Sep 2026), Claude Code desktop (a worktree per
  session), OpenAI's Codex app. Nobody neutral sits above all of them.

**Our place:** the vendor-neutral, local-first control room. Every agent you already pay for, side
by side on one board, on your own login, with approvals that follow you to your phone.

```
                       ┌──────────── your phone (PWA) ────────────┐
                       │ launch team · approve · read · hand back │
                       └───────────────▲──────────────────────────┘
                                       │ end-to-end encrypted relay (optional account)
┌──────────────────────── AgentArmy on your computer ────────────────────────┐
│  board · orchestrator · loops · review lane · project memory · recipes     │
│     │              │              │              │              │          │
│  Claude Code     Codex        Gemini CLI     Grok Build     OpenCode       │
│  (your login)  (your login)  (your login)  (your login)   (your keys)      │
└────────────────────────────────────────────────────────────────────────────┘
        ▲ recipes / "Run in AgentArmy" links          ▲ triggers: GitHub, Slack, schedule
```

## What we take from Cursor (Sep-Oct 2026 changelog)

| Cursor | What we do instead |
| --- | --- |
| Projects: coordinator agent, parallel agents, shared context files | Orchestrator + teams exist; add project memory (Phase 7) |
| Subscriptions: react to Slack, schedules, PRs | Triggers (Phase 7); loops already cover schedules |
| Remote Control from the iOS app (local agents, Oct 6) | Phone PWA with launch-from-phone and two-way handoff (Phase 6) |
| Origin App Marketplace, public submissions (Oct 13) | Recipe gallery, later a plugin API |
| Security Review and Rollouts bots | Review lane with AI pre-review |
| Shareable canvases | Share links for recipes and run reports |
| Hobby free / Pro USD 20 / Teams USD 40 per user (third-party sources) | Free app forever; paid Team plan for shared, hosted parts |

Cursor sells its own model credits inside its editor. We never resell models: users bring the
subscriptions they have, which is why terminal users can pick us without giving anything up.

## Challenges

1. **Platform risk.** Anthropic, OpenAI and Cursor can each ship a better single-vendor board.
   Answer: stay neutral and cross-vendor, which none of them will do; run the official CLIs
   unmodified.
2. **Terms of service.** Subscription use through third-party tools and automatic account
   switching can conflict with provider terms. Answer: the user logs in to each CLI themselves, we
   never touch credentials, auto-switch stays "ask" by default.
3. **A crowded field.** Conductor, Superset, Claude Squad, Vibe Kanban, Codex app. Answer: spatial
   board, Windows + Mac, free, phone control, recipes.
4. **Trust.** The app types into terminals and is unsigned. Answer: localhost + token security
   model, open source, sign the Windows and Mac builds as soon as there is budget.
5. **Review bottleneck.** Ten agents make ten diffs. Answer: the review lane.
6. **Paying the bills while staying free.** Answer: open core. The local app stays MIT and free;
   hosted parts (relay at scale, team sync, gallery features) become a paid Team plan.
7. **Name.** agentarmy.com is taken; pick the final brand before spending on growth.

## Ecosystem-led growth

- **Meet terminal users where they are:** `npx agentarmy`, a Claude Code plugin/skill that opens the
  current session on the board, and our MCP server so any agent can spawn and brief teammates.
- **Recipes are the growth loop:** people share team setups as links and "Run in AgentArmy" badges
  in READMEs; every share is an install.
- **Community adapters:** a documented adapter interface so new CLIs get support from the community
  the week they launch.
- **Integrations:** GitHub, Linear, Slack and ntfy as triggers and notification targets.
- **Optional account as the network:** sign-in unlocks phone control, sync, sharing and publishing
  recipes, and gives us a user list without forcing anyone to register.
- **Proof in public:** board replays and GIFs of real runs on the website and socials.

Sources: https://cursor.com/changelog, https://cursor.com/docs/release-notes,
https://code.claude.com/docs/en/worktrees, https://www.tembo.io/blog/ai-agent-orchestration-tools,
https://aicodereview.cc/blog/cursor-pricing, https://uvik.net/blog/claude-code-vs-cursor-vs-copilot-vs-codex-2026/
