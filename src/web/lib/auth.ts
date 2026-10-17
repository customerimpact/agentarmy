const STORAGE_KEY = 'agentarmy.token';

let token: string | null = null;

// Pull the per-run token out of the URL so it doesn't linger in history, screenshots or bookmarks
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    token = fromUrl;
    try {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      // Storage can be blocked; the in-memory token still works for this page load
    }
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return token;
  }
  try {
    token = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    token = null;
  }
  return token;
}

export function getToken(): string | null {
  return token;
}

export function clearToken(): void {
  token = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
