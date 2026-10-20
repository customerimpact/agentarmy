import path from 'node:path';
import type {
  ActionItem,
  ActionKind,
  ConsoleInfo,
  JobStatus,
  Project,
  Recap,
  RecapActionItem,
  RecapAgent,
  RecapJob,
  RecapProject,
  WebhookKind,
} from '../shared/protocol.js';

// Daily recap, built deterministically from the day's event log (no model calls, no tokens).

export type RecapEventType =
  | 'prompt' // UserPromptSubmit
  | 'turn' // Stop, with the last assistant message
  | 'job' // a job changed status (logged for the receiver 'in' and the sender 'out')
  | 'todo_done'
  | 'action_open'
  | 'action_resolved'
  | 'file' // Edit / Write / MultiEdit / NotebookEdit target
  | 'command' // a notable shell command (tests, builds, git, deploys)
  | 'preview' // a dev preview tile opened
  | 'loop'; // a loop typed its prompt into the console (text = loop name)

export interface RecapEvent {
  t: number;
  type: RecapEventType;
  c: string | null; // console id the event belongs to
  n?: string; // console name at the time
  r?: string; // role
  p?: string | null; // project id
  pn?: string; // project name
  cwd?: string;
  id?: string; // job or action id
  text?: string; // prompt, message, todo, file path, command, url, job/action title
  detail?: string; // job result, action detail
  status?: JobStatus;
  dir?: 'in' | 'out';
  peer?: string; // the other agent's name for jobs ('you' = the user)
  kind?: ActionKind;
  waited?: number; // ms an action stayed open
}

export interface LiveRecapState {
  consoles: ConsoleInfo[];
  actions: ActionItem[];
  projects: Project[];
}

const MAX_HIGHLIGHTS = 3;
const MAX_FILES = 40;

export function localDate(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isRecapDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00`);
  return !Number.isNaN(d.getTime()) && localDate(d.getTime()) === value;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function emptyAgent(consoleId: string, name: string): RecapAgent {
  return {
    consoleId,
    name,
    prompts: 0,
    jobsReceived: [],
    jobsSent: [],
    todosCompleted: [],
    highlights: [],
    needsYou: { count: 0, waitedMs: 0, longestMs: 0, open: 0 },
    errors: [],
    files: [],
    next: [],
  };
}

function bucketOf(projectId: string | null | undefined, projectName: string | undefined, cwd: string | undefined) {
  if (projectId) return { key: `p:${projectId}`, name: projectName || 'Project', folder: cwd };
  const folder = cwd ?? '';
  return { key: `f:${folder.toLowerCase()}`, name: folder ? path.basename(folder) || folder : 'Other', folder: folder || undefined };
}

export function buildRecap(
  date: string,
  events: RecapEvent[],
  options: { live?: LiveRecapState; now?: number } = {},
): Recap {
  const now = options.now ?? Date.now();
  const isToday = localDate(now) === date;
  const live = isToday ? options.live : undefined;
  const sorted = [...events].sort((a, b) => a.t - b.t);

  const agents = new Map<string, RecapAgent>();
  const placement = new Map<string, { key: string; name: string; folder?: string }>();
  const agent = (ev: { c: string | null; n?: string }): RecapAgent | null => {
    if (!ev.c) return null;
    let a = agents.get(ev.c);
    if (!a) {
      a = emptyAgent(ev.c, ev.n || 'Agent');
      agents.set(ev.c, a);
    }
    if (ev.n) a.name = ev.n;
    return a;
  };

  const jobs = new Map<string, { agent: RecapAgent; dir: 'in' | 'out'; job: RecapJob }>();
  const opened = new Map<string, RecapEvent>(); // action id -> open event
  const resolved = new Set<string>();
  const turns = new Map<string, string[]>();

  for (const ev of sorted) {
    const a = agent(ev);
    if (a && ev.c) {
      if (ev.r) a.role = ev.r;
      placement.set(ev.c, bucketOf(ev.p, ev.pn, ev.cwd));
    }
    switch (ev.type) {
      case 'prompt':
        if (a) a.prompts++;
        break;
      case 'turn':
        if (a && ev.text) turns.set(a.consoleId, [...(turns.get(a.consoleId) ?? []), ev.text]);
        break;
      case 'job':
        if (a && ev.id && ev.dir && ev.status) {
          const key = `${ev.id}|${ev.dir}|${a.consoleId}`;
          const prev = jobs.get(key)?.job;
          jobs.set(key, {
            agent: a,
            dir: ev.dir,
            job: {
              title: ev.text ?? prev?.title ?? 'Job',
              status: ev.status,
              peer: ev.peer ?? prev?.peer ?? 'another agent',
              ...((ev.detail ?? prev?.result) ? { result: ev.detail ?? prev?.result } : {}),
            },
          });
        }
        break;
      case 'todo_done':
        if (a && ev.text && !a.todosCompleted.includes(ev.text)) a.todosCompleted.push(ev.text);
        break;
      case 'action_open':
        if (ev.id) opened.set(ev.id, ev);
        if (a && ev.kind === 'needs_you') a.needsYou.count++;
        if (a && ev.kind === 'error') a.errors.push(clip([ev.text, ev.detail].filter(Boolean).join(': '), 200));
        break;
      case 'action_resolved': {
        const open = ev.id ? opened.get(ev.id) : undefined;
        if (!open || !ev.id) break;
        resolved.add(ev.id);
        const owner = agent(open);
        if (owner && open.kind === 'needs_you') {
          const waited = ev.waited ?? Math.max(0, ev.t - open.t);
          owner.needsYou.waitedMs += waited;
          owner.needsYou.longestMs = Math.max(owner.needsYou.longestMs, waited);
        }
        break;
      }
      case 'file':
        if (a && ev.text && !a.files.includes(ev.text) && a.files.length < MAX_FILES) a.files.push(ev.text);
        break;
      case 'command':
        if (a && ev.text) a.highlights.push(`Ran \`${ev.text}\``);
        break;
      case 'preview':
        if (a && ev.text) a.highlights.push(`Opened preview ${ev.text}`);
        break;
      case 'loop':
        if (a && ev.text) a.highlights.push(`Loop "${ev.text}" ran`);
        break;
    }
  }

  for (const { agent: a, dir, job } of jobs.values()) (dir === 'in' ? a.jobsReceived : a.jobsSent).push(job);

  // Still-open needs-you waits count up to now (today) or the end of the log (past days)
  const end = isToday ? now : (sorted.at(-1)?.t ?? now);
  const openActions: RecapActionItem[] = [];
  for (const [id, ev] of opened) {
    if (resolved.has(id)) continue;
    const a = ev.c ? agents.get(ev.c) : undefined;
    if (ev.kind === 'needs_you' && a) {
      // Today the live inbox decides what is still open (below); a past day keeps what the log says
      if (!live) {
        a.needsYou.open++;
        const waited = Math.max(0, end - ev.t);
        a.needsYou.waitedMs += waited;
        a.needsYou.longestMs = Math.max(a.needsYou.longestMs, waited);
      }
    }
    if (!live && ev.kind === 'request') openActions.push({ title: ev.text ?? 'Request', detail: ev.detail, agent: a?.name, openedAt: ev.t });
  }

  // Highlights: the latest few things each agent said at the end of a turn, after commands/previews
  for (const a of agents.values()) {
    const said = [...new Set((turns.get(a.consoleId) ?? []).map((t) => clip(t, 240)))].slice(-MAX_HIGHLIGHTS);
    a.highlights = [...new Set([...a.highlights.slice(-MAX_HIGHLIGHTS), ...said])];
  }

  if (live) {
    const projects = new Map(live.projects.map((p) => [p.id, p]));
    for (const c of live.consoles) {
      const next = (c.todos ?? []).filter((t) => t.status !== 'completed');
      const known = agents.get(c.id);
      if (!known && !next.length) continue;
      const a = known ?? agent({ c: c.id, n: c.name })!;
      a.name = c.name;
      if (c.role) a.role = c.role;
      a.next = next.map((t) => ({ ...t }));
      placement.set(c.id, bucketOf(c.projectId, c.projectId ? projects.get(c.projectId)?.name : undefined, c.cwd));
    }
    const names = new Map(live.consoles.map((c) => [c.id, c.name]));
    for (const item of live.actions) {
      if (item.resolvedAt) continue;
      const a = item.consoleId ? agents.get(item.consoleId) : undefined;
      if (item.kind === 'needs_you' && a) {
        a.needsYou.open++;
        if (!opened.has(item.id)) a.needsYou.count++;
        const waited = Math.max(0, now - item.createdAt);
        a.needsYou.waitedMs += waited;
        a.needsYou.longestMs = Math.max(a.needsYou.longestMs, waited);
      }
      openActions.push({
        title: item.title,
        ...(item.detail ? { detail: clip(item.detail, 300) } : {}),
        ...(item.consoleId && names.get(item.consoleId) ? { agent: names.get(item.consoleId) } : {}),
        openedAt: item.createdAt,
      });
    }
  }

  const buckets = new Map<string, RecapProject>();
  for (const a of agents.values()) {
    const place = placement.get(a.consoleId) ?? { key: 'f:', name: 'Other' };
    let bucket = buckets.get(place.key);
    if (!bucket) {
      bucket = { key: place.key, name: place.name, ...(place.folder ? { folder: place.folder } : {}), agents: [] };
      buckets.set(place.key, bucket);
    }
    bucket.agents.push(a);
  }
  const projects = [...buckets.values()]
    .map((p) => ({ ...p, agents: p.agents.sort((x, y) => x.name.localeCompare(y.name)) }))
    .sort((x, y) => x.name.localeCompare(y.name));

  const all = [...agents.values()];
  const files = new Set(all.flatMap((a) => a.files.map((f) => `${a.consoleId}|${f}`)));
  return {
    date,
    generatedAt: now,
    isToday,
    projects,
    openActions: openActions.sort((a, b) => a.openedAt - b.openedAt),
    totals: {
      agents: all.length,
      prompts: all.reduce((s, a) => s + a.prompts, 0),
      jobsDone: all.reduce((s, a) => s + a.jobsReceived.filter((j) => j.status === 'done').length, 0),
      todosCompleted: all.reduce((s, a) => s + a.todosCompleted.length, 0),
      files: files.size,
      needsYou: all.reduce((s, a) => s + a.needsYou.count, 0),
    },
  };
}

// ---------- Markdown ----------

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function list(items: string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

function timeOfDay(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Sun 18 Oct 2026", the same everywhere (toLocaleDateString differs per machine)
export function prettyDate(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function agentLines(a: RecapAgent): string[] {
  const lines: string[] = [];
  const summary = a.prompts ? [plural(a.prompts, 'prompt')] : [];
  if (a.needsYou.count) {
    const wait = a.needsYou.waitedMs ? ` (waited ${formatDuration(a.needsYou.waitedMs)}, longest ${formatDuration(a.needsYou.longestMs)})` : '';
    summary.push(`needed you ${a.needsYou.count}×${wait}${a.needsYou.open ? `, ${a.needsYou.open} still open` : ''}`);
  }
  if (summary.length) lines.push(`- ${summary.join(' · ')}`);
  for (const j of a.jobsReceived) {
    lines.push(`- Job from ${j.peer}: **${j.title}** — ${j.status}${j.result ? `: ${clip(j.result, 200)}` : ''}`);
  }
  for (const j of a.jobsSent) lines.push(`- Sent **${j.title}** to ${j.peer} — ${j.status}`);
  if (a.todosCompleted.length) lines.push(`- Completed: ${list(a.todosCompleted, 8)}`);
  if (a.files.length) lines.push(`- Files: ${list(a.files.map((f) => `\`${f}\``), 10)}`);
  for (const h of a.highlights) lines.push(`- ${h}`);
  for (const e of a.errors) lines.push(`- Error: ${e}`);
  if (a.next.length) {
    const next = a.next.map((t) => (t.status === 'in_progress' ? `${t.activeForm || t.content} (in progress)` : t.content));
    lines.push(`- Next: ${list(next, 6)}`);
  }
  return lines;
}

export function recapMarkdown(recap: Recap): string {
  const t = recap.totals;
  const out: string[] = [`# GridHive recap · ${prettyDate(recap.date)}`, ''];
  if (!recap.projects.length && !recap.openActions.length) {
    out.push('No agent activity was recorded on this day.');
    return out.join('\n');
  }
  out.push(
    [
      plural(t.agents, 'agent'),
      plural(t.prompts, 'prompt'),
      `${t.jobsDone} ${t.jobsDone === 1 ? 'job' : 'jobs'} done`,
      `${t.todosCompleted} ${t.todosCompleted === 1 ? 'todo' : 'todos'} completed`,
      `${plural(t.files, 'file')} touched`,
      `${t.needsYou} needs-you`,
    ].join(' · '),
  );
  for (const p of recap.projects) {
    out.push('', `## ${p.name}${p.folder ? ` (\`${p.folder}\`)` : ''}`);
    for (const a of p.agents) {
      out.push('', `### ${a.name}${a.role ? ` (${a.role})` : ''}`, ...agentLines(a));
    }
  }
  if (recap.openActions.length) {
    out.push('', '## Open action items');
    for (const item of recap.openActions) {
      out.push(`- ${item.agent ? `${item.agent}: ` : ''}${item.title}${item.detail ? ` — ${clip(item.detail, 160)}` : ''} (since ${timeOfDay(item.openedAt)})`);
    }
  }
  return out.join('\n');
}

// Slack mrkdwn has no headings and uses single * for bold; Discord renders Markdown as is.
// Both cap message length, so long recaps go out as several messages split on line breaks.
export function recapMessages(markdown: string, kind: WebhookKind): string[] {
  const text =
    kind === 'slack'
      ? markdown
          .split('\n')
          .map((line) => line.replace(/^#{1,6}\s+(.*)$/, '*$1*').replace(/\*\*(.+?)\*\*/g, '*$1*'))
          .join('\n')
      : markdown;
  const max = kind === 'slack' ? 3500 : 1900;
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const piece = line.length > max ? `${line.slice(0, max - 1)}…` : line;
    if (current && current.length + piece.length + 1 > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
