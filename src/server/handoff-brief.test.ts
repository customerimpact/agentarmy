import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  buildQuickBrief,
  digestTranscript,
  runSmartBrief,
  smartBriefArgs,
  smartBriefPrompt,
  type SpawnFn,
} from './handoff-brief.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\shop' : '/work/shop';
const file = (rel: string) => (process.platform === 'win32' ? `${CWD}\\${rel.replace(/\//g, '\\')}` : `${CWD}/${rel}`);

const lines = [
  // first line cut in half, like a tail read
  'ssistant","message":{"content":[]}}',
  { type: 'user', message: { role: 'user', content: 'Add a checkout page with Stripe' } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta entry' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } },
  {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'text', text: 'I will plan it.' },
        { type: 'tool_use', id: 'tu1', name: 'TodoWrite', input: { todos: [{ content: 'Old list', status: 'pending' }] } },
        { type: 'tool_use', id: 'tu2', name: 'TaskCreate', input: { subject: 'Build the cart', description: 'x' } },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Task #7 created' }] }, toolUseResult: { task: { id: '7', subject: 'Build the cart' } } },
  {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'tool_use', id: 'tu3', name: 'TaskCreate', input: { subject: 'Wire Stripe' } },
        { type: 'tool_use', id: 'tu4', name: 'Edit', input: { file_path: file('src/cart.ts'), old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 'tu5', name: 'Write', input: { file_path: file('src/checkout.tsx'), content: '' } },
        { type: 'tool_use', id: 'tu6', name: 'Edit', input: { file_path: file('src/cart.ts') } },
        { type: 'tool_use', id: 'tu7', name: 'Task', input: { description: 'Research Stripe webhooks', subagent_type: 'general' } },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu3' }] }, toolUseResult: { task: { id: '8' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu8', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'TaskUpdate', input: { taskId: '8', status: 'in_progress' } }] } },
  { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
  { type: 'user', message: { content: [{ type: 'text', text: 'Also keep the coupon field' }] } },
  { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } },
  { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Cart done; Stripe wiring is half way.' }] } },
];
const JSONL = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');

describe('digestTranscript', () => {
  it('collects prompts, the last reply, tasks, files and subagents', () => {
    const d = digestTranscript(JSONL);
    expect(d.prompts).toEqual(['Add a checkout page with Stripe', 'Also keep the coupon field']);
    expect(d.lastAssistant).toBe('Cart done; Stripe wiring is half way.');
    expect(d.todos).toEqual([
      { content: 'Old list', status: 'pending' },
      { content: 'Build the cart', status: 'completed', id: '7' },
      { content: 'Wire Stripe', status: 'in_progress', id: '8' },
    ]);
    expect(d.files).toEqual([file('src/cart.ts'), file('src/checkout.tsx')]);
    expect(d.subagents).toEqual(['Research Stripe webhooks']);
  });

  it('replaces the list on TodoWrite', () => {
    const d = digestTranscript(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'weird' }] } }] } }),
    );
    expect(d.todos).toEqual([{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]);
  });

  it('copes with empty input', () => {
    expect(digestTranscript('')).toEqual({ prompts: [], todos: [], files: [], subagents: [] });
  });
});

describe('buildQuickBrief', () => {
  it('writes every section, relative paths and the user note', () => {
    const brief = buildQuickBrief({
      fromName: 'Ada',
      cwd: CWD,
      role: 'Frontend',
      note: 'Use the test keys',
      digest: digestTranscript(JSONL),
      liveFiles: [file('src/cart.ts'), file('README.md')],
      jobs: [
        {
          job: { id: 'j', fromId: 'a', toId: 'b', title: 'Review cart', message: '', status: 'done', result: 'LGTM', createdAt: 1, updatedAt: 1 },
          direction: 'sent',
          peer: 'Bex',
        },
      ],
      git: { branch: 'feature/checkout', files: 3, added: 40, removed: 2 },
    });
    expect(brief.split('\n')[0]).toBe('[AgentArmy handoff from Ada]');
    expect(brief).toContain('Ada (Frontend) is handing its work');
    expect(brief).toContain('## Note from the user\nUse the test keys');
    expect(brief).toContain('- Add a checkout page with Stripe\n- Also keep the coupon field');
    expect(brief).toContain('## Latest status from Ada\nCart done; Stripe wiring is half way.');
    expect(brief).toContain('- [x] Build the cart');
    expect(brief).toContain('- [~] Wire Stripe (in progress)');
    expect(brief).toContain('2 of 3 still open.');
    expect(brief).toContain('- src/cart.ts\n- src/checkout.tsx\n- README.md');
    expect(brief).toContain('- Research Stripe webhooks');
    expect(brief).toContain('- "Review cart" sent to Bex (done): LGTM');
    expect(brief).toContain('Branch feature/checkout: 3 files changed, +40 −2.');
  });

  it('prefers live todos and the Stop message', () => {
    const brief = buildQuickBrief({
      fromName: 'Ada',
      cwd: CWD,
      digest: digestTranscript(JSONL),
      liveTodos: [{ content: 'Live task', status: 'pending' }],
      lastMessage: 'From the Stop hook',
    });
    expect(brief).toContain('- [ ] Live task');
    expect(brief).not.toContain('Build the cart');
    expect(brief).toContain('From the Stop hook');
    expect(brief).not.toContain('## Git');
  });
});

function fakeChild(onStdin: (text: string) => void, result: { code: number; stdout?: string; stderr?: string } | null) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let input = '';
  stdin.on('data', (d) => (input += String(d)));
  stdin.on('finish', () => {
    onStdin(input);
    if (!result) return; // hangs (timeout test)
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    stdout.end();
    stderr.end();
    setTimeout(() => child.emit('close', result.code), 5);
  });
  Object.assign(child, { stdout, stderr, stdin, pid: undefined, kill: vi.fn() });
  return child;
}

describe('runSmartBrief', () => {
  it('builds the claude -p arguments', () => {
    expect(smartBriefArgs('/tmp/s.json')).toEqual([
      '-p', '--model', 'haiku', '--output-format', 'text', '--settings', '/tmp/s.json',
      '--strict-mcp-config', '--tools', '', '--no-session-persistence',
    ]);
  });

  it('spawns claude in the source folder with its env and pipes the prompt on stdin', async () => {
    let stdinText = '';
    const spawn = vi.fn(((_file, _args, _opts) => fakeChild((t) => (stdinText = t), { code: 0, stdout: '  Goal: x\n' })) as SpawnFn);
    const out = await runSmartBrief({
      executable: '/usr/bin/claude',
      cwd: CWD,
      env: { CLAUDE_CONFIG_DIR: '/acc/2' },
      quickBrief: 'QUICK',
      spawn,
      platform: 'linux',
      settingsFile: '/tmp/nohooks.json',
    });
    expect(out).toBe('Goal: x');
    const [file, args, opts] = spawn.mock.calls[0];
    expect(file).toBe('/usr/bin/claude');
    expect(args).toEqual(smartBriefArgs('/tmp/nohooks.json'));
    expect(opts).toMatchObject({ cwd: CWD, env: { CLAUDE_CONFIG_DIR: '/acc/2' } });
    expect(opts.windowsVerbatimArguments).toBeUndefined();
    expect(stdinText).toBe(smartBriefPrompt('QUICK'));
    expect(stdinText).toContain('Goal, Done, Left to do, Key files, Gotchas');
  });

  it('goes through cmd.exe for a .cmd shim on Windows', async () => {
    const spawn = vi.fn(((_f, _a, _o) => fakeChild(() => {}, { code: 0, stdout: 'ok' })) as SpawnFn);
    await runSmartBrief({
      executable: 'C:\\npm\\claude.cmd',
      cwd: 'C:\\w',
      env: { ComSpec: 'C:\\Windows\\cmd.exe' },
      quickBrief: 'Q',
      spawn,
      platform: 'win32',
      settingsFile: 'C:\\t\\s.json',
    });
    const [file, args, opts] = spawn.mock.calls[0];
    expect(file).toBe('C:\\Windows\\cmd.exe');
    expect(args).toEqual(['/d /s /c "C:\\npm\\claude.cmd -p --model haiku --output-format text --settings C:\\t\\s.json --strict-mcp-config --tools "" --no-session-persistence"']);
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it('rejects on a failing exit and on empty output', async () => {
    const base = { executable: 'claude', cwd: CWD, env: {}, quickBrief: 'Q', platform: 'linux' as const, settingsFile: 's' };
    await expect(
      runSmartBrief({ ...base, spawn: (() => fakeChild(() => {}, { code: 1, stderr: 'Not logged in' })) as SpawnFn }),
    ).rejects.toThrow('Not logged in');
    await expect(runSmartBrief({ ...base, spawn: (() => fakeChild(() => {}, { code: 0, stdout: ' ' })) as SpawnFn })).rejects.toThrow(
      'returned nothing',
    );
  });

  it('times out and kills the process', async () => {
    const child = fakeChild(() => {}, null);
    await expect(
      runSmartBrief({ executable: 'claude', cwd: CWD, env: {}, quickBrief: 'Q', platform: 'linux', settingsFile: 's', timeoutMs: 30, spawn: (() => child) as SpawnFn }),
    ).rejects.toThrow('longer than');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
