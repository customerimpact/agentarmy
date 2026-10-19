import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitStats, Job, TodoItem, TodoStatus } from '../shared/protocol.js';
import { buildSpawnCommand } from './claude-path.js';

// Handoff briefs. Quick: built deterministically from the source agent's transcript JSONL plus what
// the hooks told us live (no tokens). Smart: the quick brief summarized by `claude -p --model haiku`.
//
// Transcript entries used (Claude Code 2.1.x): { type: 'user', message: { content: string | blocks } }
// for prompts (tool results are user entries whose blocks are tool_result; isMeta / <command-...>
// entries are Claude Code's own), { type: 'assistant', message: { content: [text | tool_use] } } for
// replies and tool calls. TaskCreate's id only shows in the next user entry's toolUseResult.task.id.

type Obj = Record<string, unknown>;

const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_PROMPTS = 5;
const MAX_FILES = 25;
const MAX_JOBS = 6;
const MAX_PROMPT_CHARS = 600;
const MAX_SUMMARY_CHARS = 2500;
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const TODO_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

function obj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface TranscriptDigest {
  prompts: string[]; // user prompts, oldest first
  lastAssistant?: string; // the latest assistant text
  todos: TodoItem[];
  files: string[]; // absolute or as written in the tool input, first touch order
  subagents: string[]; // Task / Agent tool descriptions
}

function isOwnUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted')
  );
}

function userText(message: Obj | undefined): string | undefined {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((b) => obj(b)?.type === 'tool_result')) return undefined;
  const text = content
    .map((b) => (obj(b)?.type === 'text' ? str(obj(b)?.text) : undefined))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function todoStatus(value: unknown): TodoStatus {
  return TODO_STATUSES.has(value as TodoStatus) ? (value as TodoStatus) : 'pending';
}

// Parses transcript JSONL text (a tail is fine: a cut first line is skipped)
export function digestTranscript(text: string): TranscriptDigest {
  const digest: TranscriptDigest = { prompts: [], todos: [], files: [], subagents: [] };
  const files = new Set<string>();
  // TaskCreate: tool_use id -> todo, until the result gives it a task id
  const createdBy = new Map<string, TodoItem>();
  let todos: TodoItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Obj;
    try {
      entry = JSON.parse(line) as Obj;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    const message = obj(entry.message);
    if (entry.type === 'user') {
      const result = obj(entry.toolUseResult);
      const taskId = str(obj(result?.task)?.id);
      if (taskId && Array.isArray(message?.content)) {
        for (const block of message.content) {
          const useId = str(obj(block)?.tool_use_id);
          const todo = useId ? createdBy.get(useId) : undefined;
          if (todo) {
            todo.id = taskId;
            createdBy.delete(useId!);
          }
        }
      }
      if (entry.isMeta === true) continue;
      const prompt = userText(message);
      if (prompt && !isOwnUserText(prompt)) digest.prompts.push(prompt);
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(message?.content)) continue;
    if (typeof message.model === 'string' && message.model.startsWith('<')) continue;
    const texts: string[] = [];
    for (const raw of message.content) {
      const block = obj(raw);
      if (!block) continue;
      if (block.type === 'text' && str(block.text)) texts.push(block.text as string);
      if (block.type !== 'tool_use') continue;
      const name = str(block.name) ?? '';
      const input = obj(block.input) ?? {};
      if (FILE_TOOLS.has(name)) {
        const file = str(input.file_path) ?? str(input.notebook_path);
        if (file) files.add(file);
      } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos.flatMap((t) => {
          const item = obj(t);
          const content = item && str(item.content);
          return content ? [{ content, status: todoStatus(item.status) }] : [];
        });
      } else if (name === 'TaskCreate') {
        const subject = str(input.subject);
        if (subject) {
          const todo: TodoItem = { content: subject, status: 'pending' };
          todos.push(todo);
          const useId = str(block.id);
          if (useId) createdBy.set(useId, todo);
        }
      } else if (name === 'TaskUpdate') {
        const id = str(input.taskId);
        const todo = id ? todos.find((t) => t.id === id) : undefined;
        if (todo && input.status === 'deleted') todos = todos.filter((t) => t !== todo);
        else if (todo) {
          if (TODO_STATUSES.has(input.status as TodoStatus)) todo.status = input.status as TodoStatus;
          if (str(input.subject)) todo.content = input.subject as string;
        }
      } else if (name === 'Task' || name === 'Agent') {
        const what = str(input.description) ?? str(input.subagent_type);
        if (what) digest.subagents.push(oneLine(what));
      }
    }
    if (texts.length) digest.lastAssistant = texts.join('\n');
  }
  digest.todos = todos;
  digest.files = [...files];
  return digest;
}

// The end of a transcript file ('' when missing)
export async function readTranscriptTail(file: string, maxBytes = TAIL_BYTES): Promise<string> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface GitInfo {
  branch: string | null;
  files: number;
  added: number;
  removed: number;
}

// Branch and uncommitted diff stats of a folder; null outside a git repo (or without git)
export function readGitInfo(cwd: string): GitInfo | null {
  const run = (args: string[]): string | null => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return null;
  const stat = run(['diff', 'HEAD', '--shortstat']) ?? '';
  const num = (re: RegExp): number => Number(re.exec(stat)?.[1] ?? 0);
  return {
    branch: branch === 'HEAD' ? null : branch,
    files: num(/(\d+) files? changed/),
    added: num(/(\d+) insertions?/),
    removed: num(/(\d+) deletions?/),
  };
}

export interface BriefJob {
  job: Job;
  direction: 'sent' | 'received';
  peer: string; // the other agent's name, or 'the user'
}

export interface QuickBriefInput {
  fromName: string;
  cwd: string;
  role?: string;
  note?: string;
  digest: TranscriptDigest;
  liveTodos?: TodoItem[]; // from hooks; preferred over the transcript's list
  liveFiles?: string[]; // Edit/Write targets seen in hooks
  lastMessage?: string; // last_assistant_message of the latest Stop hook
  jobs?: BriefJob[];
  git?: { branch: string | null; files: number; added: number; removed: number } | null;
}

function relPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return file.replace(/\\/g, '/');
}

const TODO_MARK: Record<TodoStatus, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };

export function handoffHeader(fromName: string): string {
  return `[AgentArmy handoff from ${fromName}]`;
}

export function buildQuickBrief(input: QuickBriefInput): string {
  const { digest, cwd } = input;
  const out: string[] = [handoffHeader(input.fromName)];
  out.push(
    `${input.fromName}${input.role ? ` (${input.role})` : ''} is handing its work in ${cwd} over to you. ` +
      'You do not see its conversation, so this brief is everything you get.',
  );
  if (input.note?.trim()) out.push('', '## Note from the user', input.note.trim());

  const prompts = digest.prompts.slice(-MAX_PROMPTS).map((p) => `- ${clip(oneLine(p), MAX_PROMPT_CHARS)}`);
  if (prompts.length) out.push('', '## What it was asked (latest last)', ...prompts);

  const summary = input.lastMessage?.trim() || digest.lastAssistant?.trim();
  if (summary) out.push('', `## Latest status from ${input.fromName}`, clip(summary, MAX_SUMMARY_CHARS));

  const todos = input.liveTodos?.length ? input.liveTodos : digest.todos;
  if (todos.length) {
    out.push('', '## Tasks');
    for (const t of todos) out.push(`- ${TODO_MARK[t.status]} ${oneLine(t.content)}${t.status === 'in_progress' ? ' (in progress)' : ''}`);
    const open = todos.filter((t) => t.status !== 'completed').length;
    out.push(open ? `${open} of ${todos.length} still open.` : 'All tasks are done.');
  }

  const files = [...new Set([...digest.files, ...(input.liveFiles ?? [])].map((f) => relPath(f, cwd)))];
  if (files.length) {
    out.push('', '## Files it changed');
    for (const f of files.slice(0, MAX_FILES)) out.push(`- ${f}`);
    if (files.length > MAX_FILES) out.push(`- …and ${files.length - MAX_FILES} more`);
  }

  if (digest.subagents.length) {
    out.push('', '## Subagents it ran', ...digest.subagents.slice(-5).map((s) => `- ${clip(s, 120)}`));
  }

  const jobs = (input.jobs ?? []).slice(-MAX_JOBS);
  if (jobs.length) {
    out.push('', '## Recent jobs with other agents');
    for (const { job, direction, peer } of jobs) {
      const result = job.result ? `: ${clip(oneLine(job.result), 200)}` : '';
      out.push(`- "${job.title}" ${direction === 'sent' ? 'sent to' : 'received from'} ${peer} (${job.status})${result}`);
    }
  }

  if (input.git) {
    const g = input.git;
    const changes = g.files ? `${g.files} file${g.files === 1 ? '' : 's'} changed, +${g.added} −${g.removed}` : 'no uncommitted changes';
    out.push('', '## Git', `Branch ${g.branch ?? '(detached)'}: ${changes}.`);
  }

  out.push('', 'Read the files above before changing anything, then carry on with what is still open.');
  return out.join('\n');
}

export function gitFromStats(branch: string | undefined, stats: GitStats | undefined): QuickBriefInput['git'] {
  if (!stats) return null;
  return { branch: branch ?? null, files: stats.files, added: stats.added, removed: stats.removed };
}

// ---------- smart mode: claude -p ----------

export const SMART_TIMEOUT_MS = 90_000;
export const SMART_INSTRUCTION =
  'Write a concise handoff brief for another coding agent that takes over this work. ' +
  'Use these headings: Goal, Done, Left to do, Key files, Gotchas. Plain markdown, at most 300 words. ' +
  'Use only the facts below; do not invent anything. Output only the brief.';

// A settings file that turns off every hook (the user's and ours), so the summary run is invisible
export function writeNoHooksSettings(dir = path.join(os.tmpdir(), 'agentarmy')): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'handoff-no-hooks.json');
  fs.writeFileSync(file, JSON.stringify({ disableAllHooks: true }));
  return file;
}

// Non-interactive, no tools, no MCP servers, nothing saved: just a text summary from haiku.
// The prompt goes in on stdin (long text and Windows command-line quoting do not mix).
export function smartBriefArgs(settingsFile: string): string[] {
  return [
    '-p',
    '--model',
    'haiku',
    '--output-format',
    'text',
    '--settings',
    settingsFile,
    '--strict-mcp-config',
    '--tools',
    '',
    '--no-session-persistence',
  ];
}

export function smartBriefPrompt(quickBrief: string): string {
  return `${SMART_INSTRUCTION}\n\n---\n${quickBrief}\n---\n`;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SmartBriefOptions {
  executable: string; // resolved claude path
  cwd: string;
  env: Record<string, string>;
  quickBrief: string;
  timeoutMs?: number;
  spawn?: SpawnFn; // tests stub this
  platform?: NodeJS.Platform;
  settingsFile?: string;
}

function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

// Resolves with claude's stdout; rejects on a non-zero exit, empty output or the timeout
export function runSmartBrief(options: SmartBriefOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  const settingsFile = options.settingsFile ?? writeNoHooksSettings();
  const command = buildSpawnCommand(options.executable, smartBriefArgs(settingsFile), { platform, env: options.env });
  const verbatim = typeof command.args === 'string';
  const args = typeof command.args === 'string' ? [command.args] : command.args;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command.file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err: Error | null, text?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(text ?? '');
    };
    const timer = setTimeout(() => {
      killTree(child, platform);
      finish(new Error(`claude -p took longer than ${Math.round((options.timeoutMs ?? SMART_TIMEOUT_MS) / 1000)} s`));
    }, options.timeoutMs ?? SMART_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout += d));
    child.stderr?.on('data', (d: string) => (stderr += d));
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      const text = stdout.trim();
      if (code !== 0) finish(new Error(clip(oneLine(stderr || text) || `claude -p exited with code ${code}`, 300)));
      else if (!text) finish(new Error('claude -p returned nothing'));
      else finish(null, text);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(smartBriefPrompt(options.quickBrief));
  });
}
