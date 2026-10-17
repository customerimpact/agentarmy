import { execSync } from 'node:child_process';
import { REPO_ROOT } from './helpers/server';

// The server serves dist/web, so build the real UI once (the server itself runs from source via tsx)
export default function globalSetup(): void {
  if (process.env.E2E_SKIP_BUILD === '1') return;
  execSync('npx vite build --logLevel warn', { cwd: REPO_ROOT, stdio: 'inherit' });
}
