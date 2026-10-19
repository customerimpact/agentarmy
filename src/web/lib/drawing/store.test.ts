import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHAPE_STYLE, type Shape } from '../../../shared/drawings';

// The drawings store with a fake fetch: undo/redo, debounced batching, retries, remote changes.

type StoreModule = typeof import('./store');
let mod: StoreModule;
const calls: { url: string; body: unknown }[] = [];
let fail = false;

const rect = (id: string, x = 0): Shape => ({ id, kind: 'rect', workspaceId: 'main', x, y: 0, w: 10, h: 10, style: DEFAULT_SHAPE_STYLE, z: 1, createdAt: 1, updatedAt: 1 });

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify({ ok: true, shapes: [rect('server')] }), { status: 200 });
  });
  mod = await import('./store');
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mod.resetDrawingsForTests();
  calls.length = 0;
  fail = false;
});

describe('drawings store', () => {
  it('commits, batches the sync and undoes / redoes', async () => {
    const { useDrawings } = mod;
    useDrawings.getState().commit([{ id: 'a', before: null, after: rect('a') }]);
    useDrawings.getState().commit([{ id: 'a', before: rect('a'), after: rect('a', 40) }]);
    expect(useDrawings.getState().shapes.a.x).toBe(40);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/drawings/ops');
    expect(calls[0].body).toMatchObject({ upsert: [{ id: 'a', x: 40 }], remove: [], origin: mod.TAB_ID });

    useDrawings.getState().undo();
    expect(useDrawings.getState().shapes.a.x).toBe(0);
    useDrawings.getState().undo();
    expect(useDrawings.getState().shapes.a).toBeUndefined();
    expect(useDrawings.getState().canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls[1].body).toMatchObject({ upsert: [], remove: ['a'] });
    useDrawings.getState().redo();
    expect(useDrawings.getState().shapes.a.x).toBe(0);
    expect(useDrawings.getState().canRedo).toBe(true);
  });

  it('retries when offline, keeping newer local edits', async () => {
    const { useDrawings } = mod;
    fail = true;
    useDrawings.getState().commit([{ id: 'b', before: null, after: rect('b') }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(1);
    expect(useDrawings.getState().syncError).toMatch(/not saved/);
    fail = false;
    await vi.advanceTimersByTimeAsync(3100);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ upsert: [{ id: 'b' }] });
    expect(useDrawings.getState().syncError).toBeNull();
  });

  it('applies other tabs’ changes but not its own echo or over unsaved edits', () => {
    const { useDrawings, TAB_ID } = mod;
    useDrawings.getState().applyRemote([rect('r')], [], 'other');
    expect(useDrawings.getState().shapes.r).toBeDefined();
    useDrawings.getState().applyRemote([rect('echo')], [], TAB_ID);
    expect(useDrawings.getState().shapes.echo).toBeUndefined();
    useDrawings.getState().commit([{ id: 'mine', before: null, after: rect('mine', 5) }]);
    useDrawings.getState().applyRemote([rect('mine', 99)], ['r'], 'other');
    expect(useDrawings.getState().shapes.mine.x).toBe(5);
    expect(useDrawings.getState().shapes.r).toBeUndefined();
  });

  it('restyles the selection as one undo step and deletes the selection', () => {
    const { useDrawings } = mod;
    const st = useDrawings.getState();
    st.commit([
      { id: 'a', before: null, after: rect('a') },
      { id: 'b', before: null, after: rect('b') },
    ]);
    st.select(['a', 'b']);
    st.setStyle({ color: 'teal' });
    expect(useDrawings.getState().shapes.a.style.color).toBe('teal');
    expect(useDrawings.getState().shapes.b.style.color).toBe('teal');
    useDrawings.getState().undo();
    expect(useDrawings.getState().shapes.a.style.color).toBe('ink');
    useDrawings.getState().select(['a']);
    useDrawings.getState().removeSelected();
    expect(Object.keys(useDrawings.getState().shapes)).toEqual(['b']);
    expect(useDrawings.getState().selected).toEqual([]);
  });

  it('loads from the server, keeping unsaved local edits', async () => {
    const { useDrawings, loadDrawings } = mod;
    useDrawings.getState().commit([{ id: 'local', before: null, after: rect('local') }]);
    await loadDrawings();
    expect(Object.keys(useDrawings.getState().shapes).sort()).toEqual(['local', 'server']);
  });
});
