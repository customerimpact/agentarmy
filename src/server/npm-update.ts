import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewerVersion } from '../shared/version.js';

// `npx agentarmy` prints one line when npm has a newer version. Quiet when offline,
// when the package is not on npm yet, or when AGENTARMY_DISABLE_UPDATES=1.

const REGISTRY_URL = 'https://registry.npmjs.org/gridhive/latest';

// Walks up from this file to our package.json (dist/cli.js in the package, src/server/ in dev)
export function ownVersion(start = path.dirname(fileURLToPath(import.meta.url))): string | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if ((pkg.name === 'gridhive' || pkg.name === 'agentarmy') && pkg.version) return pkg.version;
    } catch {
      // no package.json here
    }
    if (path.dirname(dir) === dir) return null;
  }
}

export async function npmUpdateNotice(current: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version?: string };
    if (!version || !isNewerVersion(version, current)) return null;
    return `GridHive ${version} is available (you have ${current}). Run: npx gridhive@latest`;
  } catch {
    return null;
  }
}
