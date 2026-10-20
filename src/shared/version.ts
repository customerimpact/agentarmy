// "0.0.10" > "0.0.9"; a leading "v" and prerelease suffixes are ignored
export function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
