# Contributing

Thanks for helping. Bug reports, fixes and small focused features are welcome. For anything large, open an issue first so we can agree on the approach.

## Setup

Requirements: Node 20+ (22 recommended), Claude Code installed and logged in, and build tools for `node-pty` (see the README).

```sh
npm install
npm run dev
```

The dev server runs on `127.0.0.1:4317` and the Vite UI on `:5173` with hot reload.

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run build
```

All three must pass. CI runs them on Windows, macOS and Linux.

## Code style

- Follow [.agent-os/product/code-style.md](.agent-os/product/code-style.md).
- Formatting is defined in [.prettierrc](.prettierrc) (single quotes, semicolons, trailing commas, 100 columns). Run Prettier on the files you change.
- Keep changes small and focused. Do not reformat unrelated code.
- `src/shared/protocol.ts` is the contract between server and UI. Changes there need both sides updated in the same PR.

## Tests

New behavior needs tests (Vitest). Bug fixes should come with a test that fails without the fix. Anything touching process spawning, paths or shells should keep Windows in mind.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(board): add minimap toggle
fix(server): resolve claude.cmd on Windows
docs: clarify --port option
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
