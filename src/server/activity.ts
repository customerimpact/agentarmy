import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TodoItem, TodoStatus } from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import type { HookPayload } from './hook-status.js';

// Progress data read from hook payloads: the agent's todo list, what it is doing right now, its model.
//
// Payload shapes verified against Claude Code 2.1.302 (real interactive run, 2026-10-18):
// - SessionStart (interactive) carries `model`, e.g. "claude-haiku-5-5". Headless `-p` runs do not,
//   and no other event does, so on Stop we also read the last assistant `message.model` from the
//   transcript tail.
// - TaskCreate: tool_input { subject, description, activeForm? }; the id only appears in the
//   PostToolUse tool_response { task: { id: "1", subject } }.
// - TaskUpdate: tool_input { taskId: "1", status?: pending|in_progress|completed|deleted, subject?,
//   activeForm? }; PostToolUse tool_response { success, taskId, updatedFields, statusChange? }.
// - TaskList: PostToolUse tool_response { tasks: [{ id, subject, status, owner?, blockedBy }] }.
// - TodoWrite (older/other setups): tool_input { todos: [{ content, status, activeForm }] } replaces
//   the whole list. Task* tools only show up with CLAUDE_CODE_ENABLE_TASKS=1 in that version.
// - "/model haiku" fires no hook. It writes two user entries to the transcript right away:
//   content "<command-name>/model</command-name>...<command-args>haiku</command-args>" and then
//   content "<local-command-stdout>Set model to `Haiku 5.5` and saved as ...</local-command-stdout>".
//   The screen prints the same "Set model to ..." line, which ConsoleManager reports as a
//   'model-switch' event; we then re-read the transcript tail.

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const MAX_ACTIVITY = 80;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function todoStatus(value: unknown): TodoStatus {
  return TODO_STATUSES.has(value as TodoStatus) ? (value as TodoStatus) : 'pending';
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// Returns the new list, or null when the payload does not touch the todo list
export function applyTodoHook(current: TodoItem[] | undefined, payload: HookPayload): TodoItem[] | null {
  const event = payload.hook_event_name;
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return null;
  const input = obj(payload.tool_input) ?? {};
  const response = obj(payload.tool_response);
  const list = current ?? [];

  switch (payload.tool_name) {
    case 'TodoWrite': {
      // Same list arrives on Pre and Post; applying it twice is harmless
      if (!Array.isArray(input.todos)) return null;
      return input.todos.flatMap((raw) => {
        const t = obj(raw);
        const content = t && str(t.content);
        if (!t || !content) return [];
        const item: TodoItem = { content, status: todoStatus(t.status) };
        if (str(t.activeForm)) item.activeForm = t.activeForm as string;
        return [item];
      });
    }
    case 'TaskCreate': {
      if (event !== 'PostToolUse') return null; // the id only exists after the tool ran
      const subject = str(input.subject) ?? str(obj(response?.task)?.subject);
      if (!subject) return null;
      const id = str(obj(response?.task)?.id);
      const item: TodoItem = { content: subject, status: 'pending' };
      if (id) item.id = id;
      if (str(input.activeForm)) item.activeForm = input.activeForm as string;
      return [...list.filter((t) => !id || t.id !== id), item];
    }
    case 'TaskUpdate': {
      if (event !== 'PostToolUse' || response?.success === false) return null;
      const id = str(input.taskId) ?? str(response?.taskId);
      if (!id) return null;
      if (input.status === 'deleted') return list.filter((t) => t.id !== id);
      const index = list.findIndex((t) => t.id === id);
      if (index < 0) {
        // Created before we were watching (e.g. a resumed session): only add it if we know its name
        const subject = str(input.subject);
        return subject ? [...list, { id, content: subject, status: todoStatus(input.status) }] : null;
      }
      const next = { ...list[index] };
      if (TODO_STATUSES.has(input.status as TodoStatus)) next.status = input.status as TodoStatus;
      if (str(input.subject)) next.content = input.subject as string;
      if (str(input.activeForm)) next.activeForm = input.activeForm as string;
      return list.map((t, i) => (i === index ? next : t));
    }
    case 'TaskList': {
      if (event !== 'PostToolUse' || !Array.isArray(response?.tasks)) return null;
      const known = new Map(list.filter((t) => t.id).map((t) => [t.id, t]));
      return response.tasks.flatMap((raw) => {
        const t = obj(raw);
        const content = t && str(t.subject);
        if (!t || !content) return [];
        const id = str(t.id);
        const item: TodoItem = { content, status: todoStatus(t.status) };
        if (id) item.id = id;
        const activeForm = id ? known.get(id)?.activeForm : undefined;
        if (activeForm) item.activeForm = activeForm;
        return [item];
      });
    }
    default:
      return null;
  }
}

function shortPath(file: string, cwd: string | undefined): string {
  if (cwd) {
    const rel = path.relative(cwd, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  }
  return file.replace(/\\/g, '/');
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// A short, plain description of a tool call, e.g. "Edit src/a.ts" or "Bash: npm test"
export function describeToolUse(toolName: string, input: Obj, cwd?: string): string {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return clip(file ? `${toolName} ${shortPath(file, cwd)}` : toolName, MAX_ACTIVITY);
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command);
      return command ? `${toolName}: ${clip(command, 60)}` : toolName;
    }
    case 'Grep':
      return str(input.pattern) ? `Search "${clip(input.pattern as string, 60)}"` : 'Search';
    case 'Glob':
      return str(input.pattern) ? `Find ${clip(input.pattern as string, 60)}` : 'Find files';
    case 'WebFetch':
      return str(input.url) ? `Web: ${host(input.url as string)}` : 'Web';
    case 'WebSearch':
      return str(input.query) ? `Web search "${clip(input.query as string, 60)}"` : 'Web search';
    case 'Task':
    case 'Agent': {
      const what = str(input.description) ?? str(input.subagent_type);
      return what ? `Agent: ${clip(what, 60)}` : 'Agent';
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return 'Updating tasks';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return clip(`${mcp[1]}: ${mcp[2]}`, MAX_ACTIVITY);
  return clip(toolName, MAX_ACTIVITY);
}

const MODEL_FAMILY = /\b(opus|sonnet|haiku|fable)\s+(\d+(?:\.\d+)*)/i;

// "Haiku 5.5" -> "claude-haiku-5-5", "Opus 5.5 (1M context)" -> "claude-opus-5-5[1m]"
export function modelIdFromDisplayName(name: string): string {
  const match = MODEL_FAMILY.exec(name);
  if (!match) return name.trim();
  const context = /\b1M\b/i.test(name) ? '[1m]' : '';
  return `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, '-')}${context}`;
}

function modelFromLine(line: string): string | undefined {
  const assistant = line.includes('"assistant"');
  const switched = line.includes('Set model to');
  if (!assistant && !switched) return undefined;
  try {
    const entry = JSON.parse(line) as Obj;
    if (entry.type === 'assistant') {
      const model = str(obj(entry.message)?.model);
      // '<synthetic>' marks messages Claude Code wrote itself (errors, interruptions)
      return model && !model.startsWith('<') ? model : undefined;
    }
    if (entry.type === 'user' && switched) {
      const content = obj(entry.message)?.content;
      if (typeof content !== 'string') return undefined;
      const set = /<local-command-stdout>\s*Set model to\s+`?([^`<\n]+?)`?(?:\s+and\b|\s*<|\s*$)/.exec(content);
      return set ? modelIdFromDisplayName(set[1]) : undefined;
    }
    return undefined;
  } catch {
    return undefined; // the first line of the tail is usually cut in half
  }
}

// Where Claude Code keeps a session's transcript when no hook told us yet
export function defaultTranscriptPath(cwd: string, sessionId: string, env = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

// Reads only the end of the transcript JSONL, newest line first
export async function readModelFromTranscript(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const model = modelFromLine(lines[i]);
      if (model) return model;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameTodos(a: TodoItem[] | undefined, b: TodoItem[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b);
}

// After "Set model to" shows on screen: the transcript entry is written at about the same time
const MODEL_SWITCH_READ_DELAYS_MS = [300, 1500];

export class ActivityTracker {
  private transcripts = new Map<string, string>();

  constructor(
    private readonly manager: ConsoleManager,
    private readonly switchDelaysMs = MODEL_SWITCH_READ_DELAYS_MS,
  ) {
    manager.on('hook', (id, payload) => this.onHook(id, payload));
    manager.on('model-switch', (id) => this.onModelSwitch(id));
    manager.on('removed', (id) => this.transcripts.delete(id));
  }

  // Re-reads the model from the transcript tail and updates the label when it changed
  async refreshModel(id: string): Promise<void> {
    const info = this.manager.get(id);
    if (!info) return;
    const file = this.transcripts.get(id) ?? defaultTranscriptPath(info.cwd, info.sessionId);
    const found = await readModelFromTranscript(file);
    const current = this.manager.get(id);
    if (found && current && current.model !== found) {
      current.model = found;
      this.manager.touch(id);
    }
  }

  private onModelSwitch(id: string): void {
    for (const delay of this.switchDelaysMs) {
      setTimeout(() => void this.refreshModel(id), delay).unref?.();
    }
  }

  onHook(id: string, payload: HookPayload): void {
    const info = this.manager.get(id);
    if (!info) return;
    let changed = false;
    if (str(payload.transcript_path)) this.transcripts.set(id, payload.transcript_path as string);

    const todos = applyTodoHook(info.todos, payload);
    if (todos && !sameTodos(info.todos, todos)) {
      info.todos = todos;
      changed = true;
    }

    const event = payload.hook_event_name;
    if (event === 'PreToolUse' && str(payload.tool_name)) {
      const activity = describeToolUse(payload.tool_name as string, obj(payload.tool_input) ?? {}, info.cwd);
      if (activity !== info.activity) {
        info.activity = activity;
        changed = true;
      }
    } else if ((event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') && info.activity) {
      delete info.activity;
      changed = true;
    }

    const model = str(payload.model);
    if (model && model !== info.model) {
      info.model = model;
      changed = true;
    }

    if (changed) this.manager.touch(id);

    // Stop: the reply's model. UserPromptSubmit: catches a /model run since the last turn.
    if (event === 'Stop' || event === 'UserPromptSubmit') void this.refreshModel(id);
  }
}
