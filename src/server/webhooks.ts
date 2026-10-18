import type { ActionItem, ConsoleInfo, WebhookKind } from '../shared/protocol.js';
import type { ConsoleManager } from './consoles.js';
import type { SettingsStore, StoredSettings } from './settings.js';

// Posts a short Slack / Discord message when an action item opens ("Ada needs you").
// Webhook URLs are secrets: never log them, never put them in error messages.

export const WEBHOOK_COOLDOWN_MS = 30_000;
const MAX_DETAIL = 300;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatActionMessage(
  action: ActionItem,
  info: { console?: Pick<ConsoleInfo, 'name'>; projectName?: string; port: number },
): string {
  const who = info.console?.name ?? 'An agent';
  const verb = action.kind === 'needs_you' ? 'needs you' : action.kind === 'error' ? 'hit an error' : 'asks for something';
  const detail = action.kind === 'request' ? [action.title, action.detail].filter(Boolean).join(' — ') : (action.detail ?? '');
  const parts = ['AgentArmy', info.projectName, `${who} ${verb}`].filter(Boolean).join(' · ');
  const body = detail ? `${parts}: ${clip(detail, MAX_DETAIL)}` : parts;
  return `${body}\nhttp://127.0.0.1:${info.port}/`;
}

export function webhookBody(kind: WebhookKind, text: string): string {
  return JSON.stringify(kind === 'slack' ? { text } : { content: text });
}

export async function postWebhook(kind: WebhookKind, url: string, text: string, fetchImpl: FetchLike = fetch): Promise<void> {
  let res: { ok: boolean; status: number };
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: webhookBody(kind, text) });
  } catch {
    // The underlying error can echo the URL; report a generic message instead
    throw new Error(`Could not reach ${kind === 'slack' ? 'Slack' : 'Discord'}`);
  }
  if (!res.ok) throw new Error(`${kind === 'slack' ? 'Slack' : 'Discord'} answered HTTP ${res.status}`);
}

function urlFor(settings: StoredSettings, kind: WebhookKind): string {
  return kind === 'slack' ? settings.slackWebhookUrl : settings.discordWebhookUrl;
}

export class WebhookNotifier {
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
    // Only items that open while we run: restored ones were already announced (or are stale)
    if (action.resolvedAt || action.createdAt < this.startedAt || this.notified.has(action.id)) return;
    this.notified.add(action.id);
    const s = this.settings.get();
    const kinds = (['slack', 'discord'] as const).filter((k) => urlFor(s, k));
    if (kinds.length === 0) return;
    const key = action.consoleId ?? 'none';
    const now = this.now();
    if (now - (this.lastByConsole.get(key) ?? -Infinity) < WEBHOOK_COOLDOWN_MS) return;
    this.lastByConsole.set(key, now);
    const text = this.messageFor(action);
    for (const kind of kinds) {
      postWebhook(kind, urlFor(s, kind), text, this.fetchImpl).catch((err: unknown) => {
        console.warn(`[agentarmy] ${(err as Error).message}`);
      });
    }
  }

  async sendTest(kind: WebhookKind): Promise<void> {
    const url = urlFor(this.settings.get(), kind);
    if (!url) throw new Error(`No ${kind === 'slack' ? 'Slack' : 'Discord'} webhook is set`);
    await postWebhook(kind, url, `AgentArmy · test message. Notifications will arrive here.\nhttp://127.0.0.1:${this.port}/`, this.fetchImpl);
  }

  private messageFor(action: ActionItem): string {
    const info = action.consoleId ? this.manager.get(action.consoleId) : undefined;
    const project = info?.projectId ? this.manager.projects.find((p) => p.id === info.projectId) : undefined;
    return formatActionMessage(action, { console: info, projectName: project?.name, port: this.port });
  }
}
