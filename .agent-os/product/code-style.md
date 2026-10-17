# Code Style (project override)

> Last Updated: 2026-10-17

TypeScript project, so this overrides the Ruby-oriented global naming rules.

- 2 spaces, single quotes, semicolons, trailing commas (see `.prettierrc`)
- camelCase for variables and functions, PascalCase for types and React components, UPPER_SNAKE_CASE for constants
- kebab-case file names except React components (`TerminalNode.tsx`)
- Multi-line Tailwind class style from the global code-style guide applies to JSX `className`
- Shared types live only in `src/shared/protocol.ts`; never duplicate them
- Comments explain "why", not "what"
