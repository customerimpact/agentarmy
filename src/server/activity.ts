import fs from 'node:fs';
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

function modelFromLine(line: string): string | undefined {
  if (!line.includes('"assistant"')) return undefined;
  try {
    const entry = JSON.parse(line) as Obj;
    if (entry.type !== 'assistant') return undefined;
    const model = str(obj(entry.message)?.model);
    // '<synthetic>' marks messages Claude Code wrote itself (errors, interruptions)
    return model && !model.startsWith('<') ? model : undefined;
  } catch {
    return undefined; // the first line of the tail is usually cut in half
  }
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

export class ActivityTracker {
  constructor(private readonly manager: ConsoleManager) {
    manager.on('hook', (id, payload) => this.onHook(id, payload));
  }

  onHook(id: string, payload: HookPayload): void {
    const info = this.manager.get(id);
    if (!info) return;
    let changed = false;

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

    if (event === 'Stop' && str(payload.transcript_path)) {
      void readModelFromTranscript(payload.transcript_path as string).then((found) => {
        const current = this.manager.get(id);
        if (found && current && current.model !== found) {
          current.model = found;
          this.manager.touch(id);
        }
      });
    }
  }
}
