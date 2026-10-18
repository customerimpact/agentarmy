import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountStore,
  DEFAULT_ACCOUNT_ID,
  copyTranscript,
  encodeProjectDir,
  metaFromConfig,
  readAccountMeta,
  transcriptFile,
} from './accounts.js';

let tmp: string;
let now: number;

function makeStore(file: string | null = path.join(tmp, 'home', 'accounts.json')) {
  return new AccountStore({
    file,
    accountsDir: path.join(tmp, 'home', 'accounts'),
    defaultDir: path.join(tmp, 'default'),
    env: {}, // no CLAUDE_CONFIG_DIR: the default reads <home>/.claude.json, but defaultDir is given
    now: () => now,
  });
}

// Claude Code's own metadata, as a login leaves it (no secrets needed for the fields we read)
function writeLogin(dir: string, email: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, organizationType: 'claude_max' }, ...extra }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-accounts-'));
  now = Date.UTC(2026, 9, 18, 12);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash, like Claude Code', () => {
    expect(encodeProjectDir('C:\\dev\\agentarmy')).toBe('C--dev-agentarmy');
    expect(encodeProjectDir('C:\\dev\\AI-Nation')).toBe('C--dev-AI-Nation');
    expect(encodeProjectDir('/home/me/my_app.v2')).toBe('-home-me-my-app-v2');
    expect(transcriptFile('/cfg', 'C:\\x y', 's1')).toBe(path.join('/cfg', 'projects', 'C--x-y', 's1.jsonl'));
  });
});

describe('metadata', () => {
  it('reads only email, plan and cached utilization', () => {
    const meta = metaFromConfig({
      oauthAccount: { emailAddress: 'me@x.com', organizationType: 'claude_max', accountUuid: 'u' },
      cachedUsageUtilization: {
        fetchedAtMs: 5,
        utilization: {
          five_hour: { utilization: 42, resets_at: '2026-10-18T15:00:00Z' },
          seven_day: { utilization: 97, resets_at: '2026-10-20T21:00:00Z' },
        },
      },
      mcpServers: { secret: { env: { TOKEN: 'never-read' } } },
    });
    expect(meta).toEqual({
      email: 'me@x.com',
      plan: 'Max',
      utilization: {
        fiveHour: 42,
        fiveHourResetsAt: Date.UTC(2026, 9, 18, 15),
        sevenDay: 97,
        sevenDayResetsAt: Date.UTC(2026, 9, 20, 21),
        at: 5,
      },
    });
  });

  it('counts a credentials file as logged in without reading it', () => {
    const dir = path.join(tmp, 'cfg');
    fs.mkdirSync(dir);
    expect(readAccountMeta(dir, false, {}).loggedIn).toBe(false);
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'not json, never parsed');
    expect(readAccountMeta(dir, false, {}).loggedIn).toBe(true);
  });
});

describe('AccountStore', () => {
  it('starts with the default account and persists extra ones', () => {
    writeLogin(path.join(tmp, 'default'), 'me@home.com');
    const store = makeStore();
    expect(store.list().map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID]);
    const work = store.create('Work');
    expect(work.status).toBe('needs_login');
    expect(fs.existsSync(work.configDir)).toBe(true);
    expect(work.configDir).toBe(path.join(tmp, 'home', 'accounts', work.id));
    const again = makeStore();
    expect(again.list().map((a) => a.name)).toEqual(['Default', 'Work']);
  });

  it('becomes ok once Claude Code stored a login in the config dir', () => {
    const store = makeStore();
    const work = store.create('Work');
    writeLogin(work.configDir, 'me@work.com');
    expect(store.get(work.id)).toMatchObject({ status: 'ok', email: 'me@work.com', plan: 'Max' });
  });

  it('injects CLAUDE_CONFIG_DIR only for extra accounts', () => {
    const store = makeStore();
    const work = store.create('Work');
    expect(store.envFor(undefined)).toEqual({});
    expect(store.envFor(DEFAULT_ACCOUNT_ID)).toEqual({});
    expect(store.envFor(work.id)).toEqual({ CLAUDE_CONFIG_DIR: work.configDir });
    expect(store.envFor('gone')).toEqual({});
  });

  it('marks limited until the reset time, then ok again', () => {
    writeLogin(path.join(tmp, 'default'), 'me@home.com');
    const store = makeStore();
    store.markLimited(DEFAULT_ACCOUNT_ID, { resetsAt: now + 3600_000, label: 'session limit' });
    expect(store.get(DEFAULT_ACCOUNT_ID)).toMatchObject({ status: 'limited', limitResetsAt: now + 3600_000, limitLabel: 'session limit' });
    now += 3600_001;
    store.refresh();
    expect(store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('ok');
  });

  it('a limit without a reset time is retried after an hour', () => {
    writeLogin(path.join(tmp, 'default'), 'me@home.com');
    const store = makeStore();
    store.markLimited(DEFAULT_ACCOUNT_ID, {});
    expect(store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('limited');
    now += 61 * 60_000;
    expect(store.get(DEFAULT_ACCOUNT_ID)?.status).toBe('ok');
  });

  it("Claude Code's cached 100% counts as limited while fresh", () => {
    writeLogin(path.join(tmp, 'default'), 'me@home.com', {
      cachedUsageUtilization: { fetchedAtMs: now - 60_000, utilization: { seven_day: { utilization: 100, resets_at: '2026-10-20T21:00:00Z' } } },
    });
    const store = makeStore();
    expect(store.get(DEFAULT_ACCOUNT_ID)).toMatchObject({ status: 'limited', limitResetsAt: Date.UTC(2026, 9, 20, 21) });
  });

  it('picks accounts in priority order, skipping limited and logged-out ones', () => {
    writeLogin(path.join(tmp, 'default'), 'me@home.com');
    const store = makeStore();
    const work = store.create('Work');
    const spare = store.create('Spare');
    writeLogin(spare.configDir, 'spare@x.com');
    store.patch({ order: [spare.id, DEFAULT_ACCOUNT_ID, work.id] });
    expect(store.list().map((a) => a.name)).toEqual(['Spare', 'Default', 'Work']);
    expect(store.resolveForNew('auto')).toBe(spare.id);
    store.markLimited(spare.id, { resetsAt: now + 1000 });
    expect(store.resolveForNew()).toBe(DEFAULT_ACCOUNT_ID);
    expect(store.pickAvailable([DEFAULT_ACCOUNT_ID])).toBeUndefined(); // Work needs a login
    store.patch({ newAgentAccount: work.id });
    expect(store.resolveForNew('auto')).toBe(work.id);
    expect(store.resolveForNew(spare.id)).toBe(spare.id);
    expect(() => store.patch({ newAgentAccount: 'nope' })).toThrow(/Unknown account/);
    expect(() => store.patch({ autoSwitch: 'maybe' })).toThrow(/autoSwitch/);
    expect(() => store.patch({ bogus: 1 })).toThrow(/Unknown field/);
  });

  it('removes extra accounts and their folder, never the default', () => {
    const store = makeStore();
    const work = store.create('Work');
    store.patch({ newAgentAccount: work.id });
    store.remove(work.id);
    expect(fs.existsSync(work.configDir)).toBe(false);
    expect(store.state().newAgentAccount).toBe('auto');
    expect(() => store.remove(DEFAULT_ACCOUNT_ID)).toThrow(/cannot be removed/);
  });

  it('validates names', () => {
    const store = makeStore(null);
    expect(() => store.create('  ')).toThrow(/name is required/);
    expect(() => store.create('x'.repeat(41))).toThrow(/longer/);
    const a = store.create('  Side   project ');
    expect(store.rename(a.id, 'Side').name).toBe('Side');
  });

  it('lists one transcript root per account', () => {
    const store = makeStore();
    const work = store.create('Work');
    expect(store.transcriptRoots()).toEqual([
      { accountId: DEFAULT_ACCOUNT_ID, dir: path.join(tmp, 'default', 'projects') },
      { accountId: work.id, dir: path.join(work.configDir, 'projects') },
    ]);
  });

  it('emits change only when the public state changed', () => {
    const store = makeStore(null);
    let n = 0;
    store.on('change', () => n++);
    store.refresh();
    expect(n).toBe(0);
    store.create('Work');
    expect(n).toBe(1);
    store.refresh();
    expect(n).toBe(1);
  });
});

describe('copyTranscript', () => {
  it('copies the session file into the same encoded folder of the other account', () => {
    const from = path.join(tmp, 'a');
    const to = path.join(tmp, 'b');
    const cwd = 'C:\\dev\\my app';
    const src = transcriptFile(from, cwd, 's1');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, '{"type":"user"}\n');
    const r = copyTranscript({ fromDir: from, toDir: to, cwd, sessionId: 's1' });
    expect(r.copied).toBe(true);
    expect(r.dest).toBe(path.join(to, 'projects', 'C--dev-my-app', 's1.jsonl'));
    expect(fs.readFileSync(r.dest, 'utf8')).toBe('{"type":"user"}\n');
  });

  it('prefers the hook transcript path and keeps its folder name', () => {
    const from = path.join(tmp, 'a');
    const src = path.join(from, 'projects', 'Some-Other-Name', 's2.jsonl');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'x\n');
    const r = copyTranscript({ fromDir: from, toDir: path.join(tmp, 'b'), cwd: '/w', sessionId: 's2', sourceFile: src });
    expect(r.dest).toBe(path.join(tmp, 'b', 'projects', 'Some-Other-Name', 's2.jsonl'));
    expect(r.copied).toBe(true);
  });

  it('keeps a longer copy that is already there, replaces a shorter one', () => {
    const from = path.join(tmp, 'a');
    const to = path.join(tmp, 'b');
    const src = transcriptFile(from, '/w', 's3');
    const dest = transcriptFile(to, '/w', 's3');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(src, 'one\ntwo\n');
    fs.writeFileSync(dest, 'one\n');
    copyTranscript({ fromDir: from, toDir: to, cwd: '/w', sessionId: 's3' });
    expect(fs.readFileSync(dest, 'utf8')).toBe('one\ntwo\n');
    fs.writeFileSync(dest, 'one\ntwo\nthree\n');
    copyTranscript({ fromDir: from, toDir: to, cwd: '/w', sessionId: 's3' });
    expect(fs.readFileSync(dest, 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('reports a missing transcript', () => {
    const r = copyTranscript({ fromDir: path.join(tmp, 'a'), toDir: path.join(tmp, 'b'), cwd: '/w', sessionId: 'nope' });
    expect(r).toMatchObject({ copied: false, reason: expect.stringMatching(/No transcript/) });
  });
});
