import fs from 'node:fs';
import path from 'node:path';

// Where installed Chromium browsers live, in preference order: Chrome, Edge, Chromium.
// Pure so it can be unit tested for every platform.
export function browserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const list: string[] = [];
  if (env.AGENTARMY_BROWSER_PATH) list.push(env.AGENTARMY_BROWSER_PATH);
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (r): r is string => Boolean(r),
    );
    const apps = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    for (const app of apps) for (const root of roots) list.push(path.win32.join(root, ...app));
    return list;
  }
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const app of apps) {
      list.push(path.posix.join('/Applications', app));
      if (env.HOME) list.push(path.posix.join(env.HOME, 'Applications', app));
    }
    return list;
  }
  const names = [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'microsoft-edge-stable',
    'chromium',
    'chromium-browser',
  ];
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  for (const name of names) for (const dir of dirs) list.push(path.posix.join(dir, name));
  list.push('/snap/bin/chromium');
  return list;
}

export function findBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  return browserCandidates(platform, env).find(exists) ?? null;
}
