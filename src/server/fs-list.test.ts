import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectory } from './fs-list.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-fs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// 'junction' needs no admin rights on Windows and is ignored elsewhere
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('listDirectory', () => {
  it('lists folders only, hides dot folders, sorts case-insensitively', async () => {
    for (const name of ['beta', 'Alpha', '.git', 'gamma']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'file.txt'), '');
    const result = await listDirectory(dir);
    expect(result.dirs.map((d) => d.name)).toEqual(['Alpha', 'beta', 'gamma']);
    expect(result.dirs[0].path).toBe(path.join(dir, 'Alpha'));
    expect(result.path).toBe(path.resolve(dir));
    expect(result.parent).toBe(path.dirname(path.resolve(dir)));
    expect(result.roots.length).toBeGreaterThan(0);
  });

  it('keeps links to folders that can be opened and hides broken ones', async () => {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.mkdirSync(path.join(dir, 'gone'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link-ok'), linkType);
    fs.symlinkSync(path.join(dir, 'gone'), path.join(dir, 'link-broken'), linkType);
    fs.rmdirSync(path.join(dir, 'gone'));
    const result = await listDirectory(dir);
    expect(result.dirs.map((d) => d.name)).toEqual(['link-ok', 'real']);
  });

  it('rejects a missing folder', async () => {
    await expect(listDirectory(path.join(dir, 'nope'))).rejects.toThrow();
  });
});
