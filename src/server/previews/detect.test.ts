import { describe, expect, it } from 'vitest';
import { detectDevUrls, isLocalUrl, terminalText } from './detect';

const urls = (raw: string, opts: Parameters<typeof detectDevUrls>[1] = {}) =>
  detectDevUrls(terminalText(raw), { complete: true, ...opts }).map((u) => u.url);

describe('terminalText', () => {
  it('drops colors and OSC sequences, turns cursor-forward into spaces and CRLF into LF', () => {
    expect(terminalText('\x1b[32mok\x1b[39m\x1b]0;title\x07 a\x1b[1Cb\r\nnext')).toBe('ok a b\nnext');
    expect(terminalText('a\x1b[3Cb')).toBe('a   b');
    expect(terminalText('x\x1b[5;1Hy')).toBe('x\ny');
  });
});

describe('detectDevUrls', () => {
  const cases: [string, string, string[]][] = [
    ['Vite (bold port in the middle of the URL)', '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n', ['http://localhost:5173/']],
    ['Vite network line is ignored', '  ➜  Local:   http://localhost:5173/\r\n  ➜  Network: http://192.168.1.20:5173/\r\n', ['http://localhost:5173/']],
    ['Next.js', '   ▲ Next.js 15.0.3\r\n   - Local:        http://localhost:3000\r\n', ['http://localhost:3000/']],
    ['Next.js old style', 'ready - started server on 0.0.0.0:3000, url: http://localhost:3000\r\n', ['http://localhost:3000/']],
    ['ready on', '> Ready on http://localhost:3000\n', ['http://localhost:3000/']],
    ['CRA', 'You can now view app in the browser.\r\n\r\n  Local:            http://localhost:3000\r\n  On Your Network:  http://10.0.0.5:3000\r\n', ['http://localhost:3000/']],
    ['Angular', '** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **\r\n', ['http://localhost:4200/']],
    ['Express "Listening on port"', 'Listening on port 8000\r\n', ['http://localhost:8000/']],
    ['Server started on port:', 'Server started on port: 4000\n', ['http://localhost:4000/']],
    ['Django', 'Starting development server at http://127.0.0.1:8000/\r\nQuit the server with CTRL-BREAK.\r\n', ['http://127.0.0.1:8000/']],
    ['Flask', ' * Running on http://127.0.0.1:5000\r\nPress CTRL+C to quit\r\n', ['http://127.0.0.1:5000/']],
    ['uvicorn', 'INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)\r\n', ['http://localhost:8000/']],
    ['python http.server', 'Serving HTTP on :: port 8000 (http://[::]:8000/) ...\r\n', ['http://localhost:8000/']],
    ['IPv6 loopback', 'listening at http://[::1]:8080\n', ['http://[::1]:8080/']],
    ['Go', '2026/10/18 10:00:00 Listening on :8080\n', ['http://localhost:8080/']],
    ['Rails', '* Listening on http://127.0.0.1:3000\r\n* Listening on http://[::1]:3000\r\n', ['http://127.0.0.1:3000/', 'http://[::1]:3000/']],
    ['Astro with base path', '┃ Local    http://localhost:4321/docs/\r\n', ['http://localhost:4321/docs/']],
    ['https dev server', 'Local: https://localhost:5173/\n', ['https://localhost:5173/']],
    ['trailing punctuation', 'Open http://localhost:5173. Enjoy!\n', ['http://localhost:5173/']],
    ['bare 0.0.0.0', 'serving on 0.0.0.0:9000\n', ['http://localhost:9000/']],
    ['remote hosts never', 'see https://example.com:8080/ and http://10.0.0.5:3000\n', []],
    ['no port', 'visit http://localhost/ later\n', []],
    ['databases are not pages', 'PostgreSQL listening on port 5432\nredis at 127.0.0.1:6379\n', []],
    ['node inspector', 'Debugger listening on ws://127.0.0.1:9229/abc-123\n', []],
    ['Claude Code TUI spaces drawn as cursor moves', '\x1b[1CThe\x1b[1Capp\x1b[1Cruns\x1b[1Cat\x1b[1Chttp://localhost:5173\x1b[1Cnow\r\n', ['http://localhost:5173/']],
  ];
  for (const [name, raw, expected] of cases) {
    it(name, () => expect(urls(raw)).toEqual(expected));
  }

  it('dedupes by origin and keeps the first path', () => {
    expect(urls('Local: http://localhost:5173/\nGET http://localhost:5173/api/users 200\n')).toEqual(['http://localhost:5173/']);
  });

  it('ignores our own server port (hook URLs in agent output)', () => {
    expect(urls('POST http://127.0.0.1:4317/hook/abc?token=x\nLocal: http://localhost:3000/\n', { ignorePorts: [4317] })).toEqual([
      'http://localhost:3000/',
    ]);
  });

  it('waits for more output when a URL touches the end of the text', () => {
    expect(detectDevUrls('Local: http://localhost:51')).toEqual([]);
    expect(detectDevUrls('Local: http://localhost:5173/\n').map((u) => u.port)).toEqual([5173]);
    expect(detectDevUrls('Local: http://localhost:51', { complete: true }).map((u) => u.port)).toEqual([51]);
  });

  it('gives the host to connect to', () => {
    const [v6] = detectDevUrls('http://[::1]:8080/ ', {});
    expect(v6).toMatchObject({ host: '::1', port: 8080, origin: 'http://[::1]:8080' });
  });
});

describe('isLocalUrl', () => {
  it('accepts only loopback http(s)', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalUrl('http://[::1]:3000')).toBe(true);
    expect(isLocalUrl('https://example.com')).toBe(false);
    expect(isLocalUrl('file:///etc/passwd')).toBe(false);
    expect(isLocalUrl('http://localhost.evil.com:3000')).toBe(false);
  });
});
