// Finds dev-server URLs in terminal output: "Local: http://localhost:5173/", "ready on
// http://localhost:3000", "Listening on port 8000", "0.0.0.0:8080". Only local hosts are ever
// returned, so a URL an agent merely mentions for some website can never open a tile.

export interface DevUrl {
  url: string; // normalized, e.g. "http://localhost:5173/"
  origin: string; // "http://localhost:5173" (one preview per console per origin)
  host: string; // host to connect to for the port check ("localhost", "127.0.0.1", "::1")
  port: number;
}

// Ports that print like servers but never serve a page (databases, debuggers, DevTools)
const NOT_HTTP_PORTS = new Set([22, 25, 53, 3306, 5432, 6379, 9222, 9229, 11211, 27017, 5037]);

// Cursor-forward (ESC[nC) is how Claude Code's TUI draws spaces, so it becomes spaces; cursor
// positioning starts a new "line"; every other escape (colors, OSC titles/hyperlinks) vanishes.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[([0-9;?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function terminalText(raw: string): string {
  return raw
    .replace(ESCAPES, (_m, params: string | undefined, _inter: string | undefined, final: string | undefined) => {
      if (final === undefined) return '';
      if (final === 'C') return ' '.repeat(Math.min(8, Math.max(1, Number.parseInt(params || '1', 10) || 1)));
      if ('HfGdABEF'.includes(final)) return '\n';
      return '';
    })
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); // eslint-disable-line no-control-regex
}

const LOCAL_HOST = String.raw`localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]`;
// http(s)://host:port/path — scheme required here, so the path is trusted
const URL_RE = new RegExp(String.raw`(https?):\/\/(${LOCAL_HOST})(?::(\d{2,5}))?(\/[^\s'"<>()\[\]{}\`|\\^]*)?`, 'gi');
// bare host:port, e.g. "Server running at localhost:3000" or "listening on 0.0.0.0:8000"
const BARE_RE = new RegExp(String.raw`(?<![\w/.:@-])(${LOCAL_HOST}):(\d{2,5})(?![\w:])`, 'gi');
// "Listening on port 8000", "Server started on port: 3000", "running at port 4000"
const PORT_RE = /\b(?:listening|listens|running|serving|served|started|starting|ready|available|server|app|up)\b[^\n]{0,30}?\bport\s*[:=]?\s*(\d{2,5})\b/gi;
// Go/Python style "Listening on :8080" / "Serving HTTP on :: port 8000"
const COLON_PORT_RE = /\blistening on\s+:(\d{2,5})\b/gi;

function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  if (h === '0.0.0.0' || h === '[::]') return 'localhost';
  return h;
}

function build(scheme: string, rawHost: string, port: number, path = '/'): DevUrl | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || NOT_HTTP_PORTS.has(port)) return null;
  const host = normalizeHost(rawHost);
  const origin = `${scheme.toLowerCase()}://${host}:${port}`;
  // Sentence punctuation right after a URL is not part of it
  const cleanPath = path.replace(/[.,;:!?'"]+$/, '') || '/';
  return { url: `${origin}${cleanPath}`, origin, host: host.replace(/^\[|\]$/g, ''), port };
}

// Each origin once, in the order found. A match touching the very end of the text may still be
// growing (the next chunk could add digits), so it is skipped until more output arrives.
export function detectDevUrls(text: string, options: { ignorePorts?: number[]; complete?: boolean } = {}): DevUrl[] {
  const ignore = new Set(options.ignorePorts ?? []);
  const found: { index: number; url: DevUrl }[] = [];
  const atEnd = (m: RegExpExecArray) => !options.complete && m.index + m[0].length >= text.length;
  for (const m of text.matchAll(URL_RE)) {
    if (atEnd(m)) continue;
    const port = m[3] ? Number(m[3]) : NaN; // a dev server always prints its port
    const url = build(m[1], m[2], port, m[4]);
    if (url) found.push({ index: m.index, url });
  }
  for (const m of text.matchAll(BARE_RE)) {
    if (atEnd(m)) continue;
    const url = build('http', m[1], Number(m[2]));
    if (url) found.push({ index: m.index, url });
  }
  for (const re of [PORT_RE, COLON_PORT_RE]) {
    for (const m of text.matchAll(re)) {
      if (atEnd(m)) continue;
      const url = build('http', 'localhost', Number(m[1]));
      if (url) found.push({ index: m.index, url });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: DevUrl[] = [];
  for (const { url } of found) {
    if (ignore.has(url.port) || seen.has(url.origin)) continue;
    seen.add(url.origin);
    out.push(url);
  }
  return out;
}

export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
