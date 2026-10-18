import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

function fakeDocument() {
  const meta = new Map<string, { content: string; setAttribute: (k: string, v: string) => void }>();
  for (const name of ['theme-color', 'color-scheme']) {
    const el = { content: '', setAttribute: (_k: string, v: string) => (el.content = v) };
    meta.set(name, el);
  }
  return {
    documentElement: { dataset: {} as Record<string, string>, style: {} as Record<string, string> },
    querySelector: (sel: string) => meta.get(/name="([^"]+)"/.exec(sel)?.[1] ?? '') ?? null,
    meta,
  };
}

async function load(stored?: Record<string, string>) {
  const storage = memoryStorage(stored);
  const doc = fakeDocument();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('document', doc);
  vi.resetModules();
  const mod = await import('./theme');
  return { mod, storage, doc };
}

describe('theme', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to ember and offers exactly four themes with terminal palettes', async () => {
    const { mod } = await load();
    expect(mod.getTheme()).toBe('ember');
    expect(mod.THEMES.map((t) => t.id)).toEqual(['ember', 'midnight', 'aurora', 'paper']);
    for (const t of mod.THEMES) {
      expect(t.swatches.length).toBeGreaterThanOrEqual(4);
      expect(mod.terminalTheme(t.id).background).toMatch(/^#/);
    }
  });

  it('persists the choice, applies it to <html> and notifies subscribers', async () => {
    const { mod, storage, doc } = await load();
    const seen: string[] = [];
    const off = mod.subscribeTheme(() => seen.push(mod.getTheme()));
    mod.setTheme('paper');
    expect(storage.data.get('agentarmy.theme')).toBe('paper');
    expect(doc.documentElement.dataset.theme).toBe('paper');
    expect(doc.documentElement.style.colorScheme).toBe('light');
    expect(doc.meta.get('theme-color')!.content).toBe('#f4f0e8');
    expect(seen).toEqual(['paper']);
    off();
    mod.setTheme('midnight');
    expect(seen).toEqual(['paper']);
  });

  it('restores a saved theme and ignores unknown values', async () => {
    expect((await load({ 'agentarmy.theme': 'aurora' })).mod.getTheme()).toBe('aurora');
    expect((await load({ 'agentarmy.theme': 'neon' })).mod.getTheme()).toBe('ember');
  });

  it('survives blocked storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('document', fakeDocument());
    vi.resetModules();
    const mod = await import('./theme');
    expect(mod.getTheme()).toBe('ember');
    expect(() => mod.setTheme('aurora')).not.toThrow();
    expect(mod.getTheme()).toBe('aurora');
  });

  it('cycles through themes in order', async () => {
    const { mod } = await load({ 'agentarmy.theme': 'paper' });
    expect(mod.cycleTheme()).toBe('ember');
    expect(mod.cycleTheme(-1)).toBe('paper');
  });
});
