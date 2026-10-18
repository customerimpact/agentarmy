import { describe, expect, it } from 'vitest';
import { browserCandidates, findBrowser } from './chrome-finder';
import { parseTileRequest } from './routes';
import { cursorPath, keyInfo, normalizeUrl, placeTile, viewportForLayout } from './util';

describe('browserCandidates', () => {
  it('prefers the override, then Chrome, Edge, Chromium on Windows', () => {
    const list = browserCandidates('win32', {
      AGENTARMY_BROWSER_PATH: 'D:\\my\\chrome.exe',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    });
    expect(list[0]).toBe('D:\\my\\chrome.exe');
    expect(list[1]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    const edge = list.indexOf('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    const chromium = list.indexOf('C:\\Users\\me\\AppData\\Local\\Chromium\\Application\\chrome.exe');
    expect(edge).toBeGreaterThan(1);
    expect(chromium).toBeGreaterThan(edge);
  });

  it('looks in /Applications on macOS and on PATH on Linux', () => {
    expect(browserCandidates('darwin', {})[0]).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    const linux = browserCandidates('linux', { PATH: '/usr/bin:/bin' });
    expect(linux[0]).toBe('/usr/bin/google-chrome');
    expect(linux).toContain('/bin/chromium');
  });

  it('returns the first candidate that exists', () => {
    const found = findBrowser('linux', { PATH: '/a:/b' }, (f) => f === '/b/chromium');
    expect(found).toBe('/b/chromium');
    expect(findBrowser('linux', { PATH: '/a' }, () => false)).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('adds https to bare domains and http to localhost', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl(' example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
  });
  it('keeps full URLs and special schemes', () => {
    expect(normalizeUrl('http://a.b')).toBe('http://a.b');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('')).toBe('about:blank');
  });
  it('turns plain words into a search', () => {
    expect(normalizeUrl('react flow docs')).toBe('https://www.google.com/search?q=react%20flow%20docs');
  });
});

describe('cursorPath', () => {
  it('ends exactly on the target and moves monotonically along a straight line', () => {
    const pts = cursorPath({ x: 0, y: 0 }, { x: 300, y: 0 }, 10);
    expect(pts).toHaveLength(10);
    expect(pts[9]).toEqual({ x: 300, y: 0 });
    for (let i = 1; i < pts.length; i++) expect(pts[i].x).toBeGreaterThanOrEqual(pts[i - 1].x);
    // Arcs a little off the straight line in the middle
    expect(Math.abs(pts[4].y)).toBeGreaterThan(0);
    expect(Math.abs(pts[4].y)).toBeLessThanOrEqual(40);
  });
  it('handles zero distance', () => {
    expect(cursorPath({ x: 5, y: 5 }, { x: 5, y: 5 }, 3)).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]);
  });
});

describe('keyInfo', () => {
  it('maps editing keys and aliases to virtual key codes', () => {
    expect(keyInfo('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(keyInfo('enter').keyCode).toBe(13);
    expect(keyInfo('esc')).toMatchObject({ key: 'Escape', keyCode: 27 });
    expect(keyInfo('ArrowDown', 'ArrowDown').keyCode).toBe(40);
    expect(keyInfo('F5').keyCode).toBe(116);
  });
  it('maps characters', () => {
    expect(keyInfo('a', 'KeyA')).toMatchObject({ keyCode: 65, text: 'a', code: 'KeyA' });
    expect(keyInfo('A')).toMatchObject({ keyCode: 65, code: 'KeyA' });
    expect(keyInfo('7')).toMatchObject({ keyCode: 55, code: 'Digit7' });
  });
});

describe('placeTile', () => {
  const anchor = { x: 0, y: 0, width: 760, height: 460 };
  it('goes right of the linked console when free', () => {
    expect(placeTile(anchor, [anchor])).toEqual({ x: 800, y: 0, width: 960, height: 640 });
  });
  it('falls back to below the console', () => {
    const blocker = { x: 800, y: 0, width: 100, height: 100 };
    expect(placeTile(anchor, [anchor, blocker])).toMatchObject({ x: 0, y: 500 });
  });
  it('uses a free grid slot without an anchor', () => {
    const slot = placeTile(undefined, []);
    expect(slot).toMatchObject({ x: 0, y: 0, width: 960 });
  });
  it('derives the page viewport from the tile size', () => {
    expect(viewportForLayout({ x: 0, y: 0, width: 960, height: 640 })).toEqual({ width: 960, height: 600 });
  });
});

describe('parseTileRequest', () => {
  it('accepts valid bodies and rejects bad ones', () => {
    expect(parseTileRequest(undefined)).toEqual({});
    expect(parseTileRequest({ url: 'x.com', layout: { x: 1.4, width: 100 } })).toEqual({
      url: 'x.com',
      layout: { x: 1, width: 240 },
    });
    expect(parseTileRequest({ linkedConsoleId: null })).toEqual({ linkedConsoleId: null });
    expect(parseTileRequest({ url: 5 })).toBeNull();
    expect(parseTileRequest({ layout: { x: 'a' } })).toBeNull();
  });
});
