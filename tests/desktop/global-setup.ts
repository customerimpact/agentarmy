import { execSync } from 'node:child_process';
import { REPO_ROOT } from '../e2e/helpers/server';

// Build the UI + desktop main/preload once (skipped when testing a packaged exe or with E2E_SKIP_BUILD=1)
export default function globalSetup(): void {
  if (process.env.E2E_SKIP_BUILD === '1' || process.env.DESKTOP_EXE) return;
  execSync('npx vite build --logLevel warn', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('node scripts/build-icons.mjs', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('npx tsup --config tsup.desktop.config.ts --silent', { cwd: REPO_ROOT, stdio: 'inherit' });
}
