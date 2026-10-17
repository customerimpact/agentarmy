const STORAGE_KEY = 'agentarmy.recentFolders';
const MAX_RECENT = 8;

export function getRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberRecentFolder(path: string): void {
  try {
    const next = [path, ...getRecentFolders().filter((p) => p !== path)].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode, blocked); recents are a convenience only
  }
}
