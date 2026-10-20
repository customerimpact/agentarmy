import { defineConfig } from '@playwright/test';

// Desktop app smoke test (Electron). Runs dist/desktop/main.js with the repo's Electron, or a packaged
// build when DESKTOP_EXE points at GridHive.exe (e.g. release/win-unpacked/GridHive.exe).
// Uses a temp AGENTARMY_HOME, a free port and the fake Claude CLI: never the real board or claude.
export default defineConfig({
  testDir: 'tests/desktop',
  globalSetup: './tests/desktop/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  outputDir: 'test-results/desktop',
});
