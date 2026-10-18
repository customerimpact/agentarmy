import type { FastifyInstance } from 'fastify';
import type { ActionItem, ConsoleInfo } from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import type { SettingsStore, StoredSettings } from './settings.js';

// Phone push notifications through ntfy.sh (free, no account) or a self-hosted ntfy server.
// The topic works like a password: anyone who knows it can read the messages. Never log it and
// never put it in error messages; GET /api/settings only shows its last 4 characters.

export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';
export const NTFY_COOLDOWN_MS = 30_000;
const MAX_TITLE = 120;
const MAX_BODY = 1000;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

// ntfy topics: letters, digits, '-' and '_' (max 64)
export function isNtfyTopic(topic: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(topic);
}

// https anywhere; plain http only for a ntfy server on this machine (self-hosting tests)
export function isNtfyServer(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.protocol === 'https:') return !!parsed.hostname;
  if (parsed.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return false;
}

// Trailing slashes off, so `${server}/${topic}` is always one slash
export function normalizeNtfyServer(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function ntfyTopicUrl(server: string, topic: string): string {
  return `${normalizeNtfyServer(server || NTFY_DEFAULT_SERVER)}/${topic}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// HTTP header values must be Latin-1 without control characters; ntfy decodes RFC 2047 words
export function headerSafe(value: string): string {
  const flat = value.replace(/[\r\n\t\0]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export interface NtfyMessage {
  title: string;
  body: string;
  priority: 'high' | 'default';
  tags: string[];
  click: string;
}

export function formatNtfyMessage(
  action: ActionItem,
  info: { console?: Pick<ConsoleInfo, 'id' | 'name'>; projectName?: string; port: number },
): NtfyMessage {
  const who = info.console?.name ?? 'An agent';
  const verb = action.kind === 'needs_you' ? 'needs you' : action.kind === 'error' ? 'hit an error' : 'asks for something';
  const title = clip([info.projectName, `${who} ${verb}`].filter(Boolean).join(' · '), MAX_TITLE);
  const detail = action.kind === 'request' ? [action.title, action.detail].filter(Boolean).join(' — ') : (action.detail ?? '');
  const body = clip(detail || (action.kind === 'needs_you' ? 'Claude Code is waiting for your input.' : 'Open AgentArmy to take a look.'), MAX_BODY);
  const tags = action.kind === 'needs_you' ? ['raising_hand'] : action.kind === 'error' ? ['warning'] : ['memo'];
  // The phone usually cannot reach 127.0.0.1 of the PC; the link still works when you tap it on this machine
  const consoleId = info.console?.id ?? action.consoleId;
  const click = consoleId
    ? `http://127.0.0.1:${info.port}/?view=console&id=${encodeURIComponent(consoleId)}`
    : `http://127.0.0.1:${info.port}/`;
  return { title, body, priority: action.kind === 'needs_you' ? 'high' : 'default', tags, click };
}

export function ntfyHeaders(message: NtfyMessage): Record<string, string> {
  return {
    'content-type': 'text/plain; charset=utf-8',
    Title: headerSafe(message.title),
    Priority: message.priority,
    Tags: message.tags.join(','),
    Click: headerSafe(message.click),
  };
}

export async function postNtfy(
  server: string,
  topic: string,
  message: NtfyMessage,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!isNtfyTopic(topic)) throw new Error('No valid ntfy topic is set');
  const url = ntfyTopicUrl(server, topic);
  if (!isNtfyServer(normalizeNtfyServer(server || NTFY_DEFAULT_SERVER))) throw new Error('The ntfy server URL is not allowed');
  let res: { ok: boolean; status: number };
  try {
    res = await fetchImpl(url, { method: 'POST', headers: ntfyHeaders(message), body: message.body });
  } catch {
    // The underlying error can echo the URL (and so the topic); keep it generic
    throw new Error('Could not reach the ntfy server');
  }
  if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
}

function target(settings: StoredSettings): { server: string; topic: string } | null {
  return settings.ntfyTopic ? { server: settings.ntfyServer || NTFY_DEFAULT_SERVER, topic: settings.ntfyTopic } : null;
}

// Same trigger and rate limit as the Slack / Discord notifier: one push per newly opened action,
// at most one per console every 30 s, nothing for items restored from disk.
export class NtfyNotifier {
  private readonly startedAt = Date.now();
  private readonly notified = new Set<string>();
  private readonly lastByConsole = new Map<string, number>();

  constructor(
    private readonly manager: ConsoleManager,
    private readonly settings: SettingsStore,
    private readonly port: number,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    manager.on('action', (action) => this.onAction(action));
  }

  onAction(action: ActionItem): void {
    if (action.resolvedAt || action.createdAt < this.startedAt || this.notified.has(action.id)) return;
    this.notified.add(action.id);
    const to = target(this.settings.get());
    if (!to) return;
    const key = action.consoleId ?? 'none';
    const now = this.now();
    if (now - (this.lastByConsole.get(key) ?? -Infinity) < NTFY_COOLDOWN_MS) return;
    this.lastByConsole.set(key, now);
    postNtfy(to.server, to.topic, this.messageFor(action), this.fetchImpl).catch((err: unknown) => {
      console.warn(`[agentarmy] ${(err as Error).message}`);
    });
  }

  async sendTest(): Promise<void> {
    const to = target(this.settings.get());
    if (!to) throw new Error('No ntfy topic is set');
    await postNtfy(
      to.server,
      to.topic,
      {
        title: 'AgentArmy test',
        body: 'Phone notifications work. You will get a push here when an agent needs you.',
        priority: 'default',
        tags: ['white_check_mark'],
        click: `http://127.0.0.1:${this.port}/`,
      },
      this.fetchImpl,
    );
  }

  private messageFor(action: ActionItem): NtfyMessage {
    const info = action.consoleId ? this.manager.get(action.consoleId) : undefined;
    const project = info?.projectId ? this.manager.projects.find((p) => p.id === info.projectId) : undefined;
    return formatNtfyMessage(action, { console: info, projectName: project?.name, port: this.port });
  }
}

// POST /api/settings/test-ntfy  -> { ok: true }
// POST /api/settings/ntfy-topic -> { topic, server, url } (full topic, for the subscribe QR code)
export async function registerNtfyRoutes(
  app: FastifyInstance,
  options: { settings: SettingsStore; notifier: NtfyNotifier },
): Promise<void> {
  const { settings, notifier } = options;
  app.post('/api/settings/test-ntfy', async (_request, reply) => {
    try {
      await notifier.sendTest();
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  // POST, not GET: keeps the secret out of caches, prefetchers and history
  app.post('/api/settings/ntfy-topic', async (_request, reply) => {
    const to = target(settings.get());
    if (!to) return reply.code(404).send({ error: 'No ntfy topic is set' });
    return { topic: to.topic, server: to.server, url: ntfyTopicUrl(to.server, to.topic) };
  });
}
