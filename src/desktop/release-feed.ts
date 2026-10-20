// Which GitHub release the desktop updater follows (pure, unit-tested)

export const UPDATE_REPO = 'customerimpact/agentarmy';
export const DESKTOP_TAG_PREFIX = 'desktop-v';
// macOS builds are not signed by Apple yet, so they cannot replace themselves: the update opens this page
export const DOWNLOAD_PAGE = 'https://agentarmy-site.vercel.app/#install';

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: { name: string }[];
}

// Windows needs latest.yml (electron-updater); the Mac download needs a .dmg
export function hasPlatformAsset(name: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' ? name.endsWith('.dmg') : name === 'latest.yml';
}

export function pickDesktopRelease(releases: GitHubRelease[], platform: NodeJS.Platform = 'win32'): string | null {
  const match = releases.find(
    (r) =>
      !r.draft &&
      !r.prerelease &&
      r.tag_name.startsWith(DESKTOP_TAG_PREFIX) &&
      (r.assets ?? []).some((a) => hasPlatformAsset(a.name, platform)),
  );
  return match ? match.tag_name : null;
}

// "0.0.10" > "0.0.9"; prerelease suffixes are ignored
export function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
