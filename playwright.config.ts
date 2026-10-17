import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the real server (from source) against the fake Claude CLI in
// tests/fake-claude, so no Claude login is needed. Each spec starts its own server.
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Keep xterm on its DOM renderer so terminal text is readable from the page
      args: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'],
    },
  },
});
