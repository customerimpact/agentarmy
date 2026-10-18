// Which GitHub release the desktop updater follows (pure, unit-tested)

export const UPDATE_REPO = 'customerimpact/agentarmy';
export const DESKTOP_TAG_PREFIX = 'desktop-v';

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: { name: string }[];
}

export function pickDesktopRelease(releases: GitHubRelease[]): string | null {
  const match = releases.find(
    (r) =>
      !r.draft &&
      !r.prerelease &&
      r.tag_name.startsWith(DESKTOP_TAG_PREFIX) &&
      (r.assets ?? []).some((a) => a.name === 'latest.yml'),
  );
  return match ? match.tag_name : null;
}
