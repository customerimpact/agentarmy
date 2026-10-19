import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATE_VERSION, type BoardState } from '../shared/protocol.js';
import { emptyState, StateStore } from './store.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sample: BoardState = {
  version: STATE_VERSION,
  viewport: { x: 10, y: -5, zoom: 0.8 },
  consoles: [
    {
      id: 'c1',
      name: 'api',
      cwd: 'C:\\dev\\api',
      sessionId: '11111111-1111-1111-1111-111111111111',
      status: 'resting',
      statusChangedAt: 1,
      layout: { x: 0, y: 0, width: 700, height: 500 },
      createdAt: 1,
    },
  ],
  jobs: [],
  actions: [],
  projects: [],
  browsers: [],
  items: [],
  loops: [],
  drawings: [],
  workspaces: [{ id: 'main', name: 'Main', createdAt: 0, order: 0 }],
};

describe('StateStore', () => {
  it('returns an empty board when no file exists', () => {
    const store = new StateStore(path.join(dir, 'nested', 'state.json'));
    expect(store.load()).toEqual(emptyState());
  });

  it('round-trips state and leaves no temp files behind', () => {
    const file = path.join(dir, 'nested', 'state.json');
    new StateStore(file).saveSync(sample);
    expect(new StateStore(file).load()).toEqual(sample);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json']);
  });

  it('overwrites an existing file atomically', () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    store.saveSync(sample);
    store.saveSync({ ...sample, consoles: [] });
    expect(store.load().consoles).toEqual([]);
  });

  it('debounces saves and flush writes the latest state', () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    let state: BoardState = emptyState();
    store.scheduleSave(() => state);
    state = sample;
    store.scheduleSave(() => state);
    expect(fs.existsSync(file)).toBe(false);
    store.flush();
    expect(store.load()).toEqual(sample);
  });

  it('loads a v1 file (consoles + viewport only) with empty v2 lists', () => {
    const file = path.join(dir, 'state.json');
    const v1 = { version: 1, viewport: sample.viewport, consoles: sample.consoles };
    fs.writeFileSync(file, JSON.stringify(v1));
    expect(new StateStore(file).load()).toEqual(sample);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.bad'))).toBe(false);
  });

  it('backs up a corrupt or future-version file instead of crashing', () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ version: 999, consoles: [] }));
    const store = new StateStore(file);
    expect(store.load().consoles).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.bad'))).toBe(true);
  });
});
