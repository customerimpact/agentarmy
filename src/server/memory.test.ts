import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryService, MemoryStore, PUSH_PREFIX, consoleFolder, folderKey, normalizeFolder } from './memory.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aa-memory-'));

afterEach(() => vi.useRealTimers());

describe('folder keys', () => {
  it('ignores case and trailing separators on Windows only', () => {
    expect(normalizeFolder('C:\\Dev\\Shop\\', 'win32')).toBe(normalizeFolder('c:\\dev\\shop', 'win32'));
    expect(folderKey('C:\\Dev\\Shop\\', 'win32')).toBe(folderKey('c:\\dev\\shop', 'win32'));
    expect(folderKey('C:\\Dev\\Shop', 'win32')).toMatch(/^[0-9a-f]{16}$/);
    expect(folderKey('/a/b', 'win32')).not.toBe(folderKey('/a/c', 'win32'));
  });

  it('uses the repo root for worktree agents', () => {
    expect(consoleFolder({ cwd: '/wt/x', git: { repoRoot: '/repo', branch: 'b', baseRef: 'main', worktree: '/wt/x' } })).toBe('/repo');
    expect(consoleFolder({ cwd: '/repo' })).toBe('/repo');
  });
});

describe('MemoryStore', () => {
  it('stores global.md and <hash>.md with the folder in a header', () => {
    const dir = tmp();
    const store = new MemoryStore(dir);
    const folder = path.join(dir, 'Shop');
    store.write('global', undefined, { content: 'Be brief.' });
    store.write('folder', folder, { content: '# Shop\nUse pnpm.', autoPush: true });

    expect(fs.readFileSync(path.join(dir, 'global.md'), 'utf8')).toBe('Be brief.');
    const file = path.join(dir, `${folderKey(folder)}.md`);
    expect(store.filePath('folder', folder)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(`<!-- agentarmy memory for folder: ${path.resolve(folder)} -->\n# Shop\nUse pnpm.`);

    const again = new MemoryStore(dir);
    expect(again.read('folder', folder)).toMatchObject({ scope: 'folder', path: path.resolve(folder), content: '# Shop\nUse pnpm.', autoPush: true });
    expect(again.read('global')).toMatchObject({ content: 'Be brief.', autoPush: false });
    expect(again.read('global').updatedAt).toBeGreaterThan(0);
    expect(again.folders().map((d) => d.path)).toEqual([path.resolve(folder)]);
    expect(again.read('folder', path.join(dir, 'other'))).toMatchObject({ content: '', updatedAt: null });
  });

  it('appends timestamped entries', () => {
    const store = new MemoryStore(null, () => new Date(2026, 9, 19, 14, 3).getTime());
    store.write('folder', '/repo', { content: 'Intro\n\n' });
    store.append('folder', '/repo', '  Tests need --runInBand  ', 'Ada');
    store.append('folder', '/repo', 'Second', undefined);
    expect(store.read('folder', '/repo').content).toBe(
      'Intro\n\n### 2026-10-19 14:03 (Ada)\nTests need --runInBand\n\n### 2026-10-19 14:03\nSecond\n',
    );
    expect(() => store.append('global', undefined, ' ')).toThrow('text is required');
    expect(() => store.read('folder', '')).toThrow('path is required');
  });
});

describe('MemoryService', () => {
  function setup() {
    const ctx = fakeManager([fakeConsole('ada'), fakeConsole('bex', 'needs_you'), fakeConsole('cy', 'exited')]);
    const store = new MemoryStore(null);
    const service = new MemoryService(ctx.manager, store, 0);
    return { ...ctx, store, service };
  }

  it('pushes to the consoles that can take typing', () => {
    const { service, store, typed } = setup();
    expect(() => service.push({ scope: 'global', consoleIds: ['ada'] })).toThrow('empty');
    store.write('global', undefined, { content: 'Always run the linter.' });
    const res = service.push({ scope: 'global', consoleIds: ['ada', 'bex', 'cy', 'zed'] });
    expect(res.sent).toEqual(['ada']);
    expect(res.skipped.map((s) => s.id)).toEqual(['bex', 'cy', 'zed']);
    expect(typed).toEqual([{ id: 'ada', text: `${PUSH_PREFIX}\nAlways run the linter.` }]);
  });

  it('auto-pushes once to a new agent after its first idle', () => {
    vi.useFakeTimers();
    const { manager, service, store, typed, setStatus } = setup();
    store.write('global', undefined, { content: 'G', autoPush: true });
    store.write('folder', process.cwd(), { content: 'F', autoPush: true });
    store.write('folder', '/elsewhere', { content: 'X', autoPush: true });
    expect(service.autoPushText(manager.get('ada')!)).toBe(`${PUSH_PREFIX}\nG\n\nF`);

    setStatus('ada', 'starting');
    manager.handleHook('ada', { hook_event_name: 'SessionStart', source: 'startup' });
    vi.runAllTimers();
    expect(typed).toEqual([{ id: 'ada', text: `${PUSH_PREFIX}\nG\n\nF` }]);
    setStatus('ada', 'resting');
    setStatus('ada', 'idle');
    vi.runAllTimers();
    expect(typed).toHaveLength(1);

    // Resumed conversations already had it
    manager.handleHook('ada', { hook_event_name: 'SessionStart', source: 'resume' });
    vi.runAllTimers();
    expect(typed).toHaveLength(1);
  });
});
