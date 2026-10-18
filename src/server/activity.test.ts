import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ActivityTracker,
  applyTodoHook,
  defaultTranscriptPath,
  describeToolUse,
  modelIdFromDisplayName,
  readModelFromTranscript,
} from './activity.js';
import { fakeConsole, fakeManager } from './orchestration-test-utils.js';

const post = (tool_name: string, tool_input: unknown, tool_response?: unknown) => ({
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_input,
  tool_response,
});

describe('applyTodoHook', () => {
  it('replaces the list from TodoWrite', () => {
    const todos = applyTodoHook(undefined, {
      hook_event_name: 'PreToolUse',
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
          { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
          { status: 'pending' },
        ],
      },
    });
    expect(todos).toEqual([
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ]);
  });

  // Payloads recorded from Claude Code 2.1.302 with CLAUDE_CODE_ENABLE_TASKS=1
  it('follows TaskCreate / TaskUpdate by task id', () => {
    let todos = applyTodoHook(undefined, {
      hook_event_name: 'PreToolUse',
      tool_name: 'TaskCreate',
      tool_input: { subject: 'First task', description: 'd' },
    });
    expect(todos).toBeNull(); // no id yet
    todos = applyTodoHook(
      undefined,
      post('TaskCreate', { subject: 'First task', description: 'd' }, { task: { id: '1', subject: 'First task' } }),
    );
    todos = applyTodoHook(
      todos!,
      post('TaskCreate', { subject: 'Second task', description: 'd', activeForm: 'Doing two' }, { task: { id: '2', subject: 'Second task' } }),
    );
    todos = applyTodoHook(
      todos!,
      post('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'] }),
    );
    expect(todos).toEqual([
      { id: '1', content: 'First task', status: 'completed' },
      { id: '2', content: 'Second task', status: 'pending', activeForm: 'Doing two' },
    ]);
    todos = applyTodoHook(todos!, post('TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true }));
    expect(todos).toEqual([{ id: '1', content: 'First task', status: 'completed' }]);
    expect(applyTodoHook(todos!, post('TaskUpdate', { taskId: '9', status: 'completed' }, { success: true }))).toBeNull();
  });

  it('replaces the list from a TaskList result and ignores unrelated tools', () => {
    const todos = applyTodoHook(
      [{ id: '1', content: 'old', status: 'pending', activeForm: 'Doing old' }],
      post('TaskList', {}, { tasks: [{ id: '1', subject: 'old', status: 'in_progress', blockedBy: [] }] }),
    );
    expect(todos).toEqual([{ id: '1', content: 'old', status: 'in_progress', activeForm: 'Doing old' }]);
    expect(applyTodoHook([], post('Read', { file_path: 'a' }))).toBeNull();
    expect(applyTodoHook([], { hook_event_name: 'Stop' })).toBeNull();
  });
});

describe('describeToolUse', () => {
  const cwd = path.resolve('/repo');
  it.each([
    ['Edit', { file_path: path.join(cwd, 'src', 'a.ts') }, 'Edit src/a.ts'],
    ['Read', { file_path: path.join(cwd, 'README.md') }, 'Read README.md'],
    ['Bash', { command: 'npm test' }, 'Bash: npm test'],
    ['Grep', { pattern: 'foo' }, 'Search "foo"'],
    ['WebFetch', { url: 'https://example.com/x?y' }, 'Web: example.com'],
    ['mcp__agentarmy__send_job', {}, 'agentarmy: send_job'],
    ['SomethingNew', {}, 'SomethingNew'],
  ])('%s', (tool, input, expected) => {
    expect(describeToolUse(tool, input, cwd)).toBe(expected);
  });

  it('cuts long commands to 60 characters', () => {
    const text = describeToolUse('Bash', { command: 'x'.repeat(200) });
    expect(text.length).toBeLessThanOrEqual('Bash: '.length + 60);
  });
});

describe('readModelFromTranscript', () => {
  it('returns the last real assistant model from the file tail', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-tr-')), 't.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user' } },
      { type: 'assistant', message: { model: 'claude-opus-5-5' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'user', message: {} },
    ];
    fs.writeFileSync(file, 'x'.repeat(70 * 1024) + '\n' + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(await readModelFromTranscript(file)).toBe('claude-opus-5-5');
    expect(await readModelFromTranscript(file + '.missing')).toBeUndefined();
  });
});

describe('ActivityTracker', () => {
  it('sets todos, activity and model from hooks and touches only on change', () => {
    const { manager } = fakeManager([fakeConsole('ada', 'working')]);
    new ActivityTracker(manager);
    let touches = 0;
    manager.on('console', () => touches++);
    manager.handleHook('ada', { hook_event_name: 'SessionStart', model: 'claude-haiku-5-5' });
    expect(manager.get('ada')!.model).toBe('claude-haiku-5-5');
    manager.handleHook('ada', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(manager.get('ada')!.activity).toBe('Bash: ls');
    const before = touches;
    manager.handleHook('ada', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(touches).toBe(before);
    manager.handleHook('ada', { hook_event_name: 'Stop' });
    expect(manager.get('ada')!.activity).toBeUndefined();
  });
});

describe('model switches (/model)', () => {
  // Shapes copied from a Claude Code 2.1.302 transcript
  const command = {
    type: 'user',
    message: {
      role: 'user',
      content:
        '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>',
    },
  };
  const stdout = {
    type: 'user',
    message: {
      role: 'user',
      content: '<local-command-stdout>Set model to `Haiku 5.5` and saved as your default for new sessions</local-command-stdout>',
    },
  };

  function transcript(entries: unknown[]): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentarmy-tr-')), 't.jsonl');
    fs.writeFileSync(file, entries.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('turns display names into model ids', () => {
    expect(modelIdFromDisplayName('Haiku 5.5')).toBe('claude-haiku-5-5');
    expect(modelIdFromDisplayName('Opus 5.5 (1M context)')).toBe('claude-opus-5-5[1m]');
    expect(modelIdFromDisplayName('Default (recommended)')).toBe('Default (recommended)');
  });

  it('reads the /model confirmation before the next assistant turn', async () => {
    const before = transcript([{ type: 'assistant', message: { model: 'claude-opus-5-5' } }, command, stdout]);
    expect(await readModelFromTranscript(before)).toBe('claude-haiku-5-5');
    // ...and a later assistant reply wins over an older switch
    const after = transcript([stdout, { type: 'assistant', message: { model: 'claude-sonnet-5' } }]);
    expect(await readModelFromTranscript(after)).toBe('claude-sonnet-5');
  });

  it('updates the label when the screen shows "Set model to", without waiting for a turn', async () => {
    const { manager } = fakeManager([fakeConsole('ada', 'resting')]);
    new ActivityTracker(manager, [0]);
    const file = transcript([{ type: 'assistant', message: { model: 'claude-opus-5-5' } }]);
    manager.handleHook('ada', { hook_event_name: 'SessionStart', model: 'claude-opus-5-5', transcript_path: file });
    expect(manager.get('ada')!.model).toBe('claude-opus-5-5');
    fs.appendFileSync(file, JSON.stringify(command) + '\n' + JSON.stringify(stdout) + '\n');
    manager.emit('model-switch', 'ada');
    await vi.waitFor(() => expect(manager.get('ada')!.model).toBe('claude-haiku-5-5'));
  });

  it('re-reads the model on Stop', async () => {
    const { manager } = fakeManager([fakeConsole('ada', 'working')]);
    new ActivityTracker(manager, [0]);
    const file = transcript([stdout, { type: 'assistant', message: { model: 'claude-haiku-5-5' } }]);
    manager.handleHook('ada', { hook_event_name: 'Stop', transcript_path: file });
    await vi.waitFor(() => expect(manager.get('ada')!.model).toBe('claude-haiku-5-5'));
  });

  it('falls back to the default transcript location', () => {
    expect(defaultTranscriptPath('C:\\dev\\agentarmy-demo','s1', { CLAUDE_CONFIG_DIR: '/cfg' })).toBe(
      path.join('/cfg', 'projects', 'C--dev-agentarmy-demo', 's1.jsonl'),
    );
  });
});
