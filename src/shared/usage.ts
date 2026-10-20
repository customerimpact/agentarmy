// Usage & budgets: token counts read from Claude Code's local transcript JSONL files.
// Shared by the server (src/server/usage.ts) and the UI (Usage section of the Progress tab).

export type UsageRange = 'today' | '5h' | '7d' | '30d';
export const USAGE_RANGES: UsageRange[] = ['today', '5h', '7d', '30d'];

export interface UsageTotals {
  input: number; // input_tokens (uncached)
  output: number; // output_tokens
  cacheCreate: number; // cache_creation_input_tokens
  cacheRead: number; // cache_read_input_tokens
  total: number; // all four added up
  weighted: number; // input + output + cacheCreate + cacheRead / 10 (what budgets compare against)
  costUsd: number; // API-equivalent estimate (see PRICES in src/shared/usage.ts)
  messages: number; // assistant messages counted
}

export interface UsageRow extends UsageTotals {
  key: string; // console id, project id ('' = no project) or model id
  label: string;
}

export interface UsageDay extends UsageTotals {
  day: string; // local date, 'YYYY-MM-DD'
}

export type BudgetScope = 'daily' | 'weekly' | '5h' | 'project';

export interface BudgetStatus {
  key: string; // 'daily' | 'weekly' | '5h' | 'project:<id>'
  scope: BudgetScope;
  label: string; // 'Today', 'Last 7 days', 'Last 5 hours', or the project name
  used: number; // weighted tokens
  limit: number;
  ratio: number; // used / limit
}

// Per Claude Code account (CLAUDE_CONFIG_DIR); 'default' = ~/.claude
export interface AccountUsage {
  accountId: string;
  today: UsageTotals;
  last5h: UsageTotals;
  last7d: UsageTotals;
}

export interface UsageReport {
  range: UsageRange;
  from: number; // epoch ms, start of the range
  generatedAt: number;
  scanning: boolean; // the background startup scan has not finished yet
  totals: UsageTotals; // GridHive consoles only, within the range
  byConsole: UsageRow[];
  byProject: UsageRow[];
  byModel: UsageRow[]; // GridHive consoles only
  byDay: UsageDay[]; // GridHive consoles, oldest first, at least the last 7 days
  machineByDay: UsageDay[]; // every Claude Code session on this machine, same days
  machineTotals: { today: UsageTotals; last5h: UsageTotals; last7d: UsageTotals };
  byAccount: AccountUsage[];
  budgets: BudgetStatus[];
  jobsPaused: boolean; // "Pause new jobs at 100%" is on and a budget is used up
}

// Compact numbers broadcast over the WebSocket every ~15 s when something changed
export interface UsageBroadcast {
  at: number;
  scanning: boolean;
  consoles: Record<string, { total: number; weighted: number; costUsd: number }>; // last 30 days
  today: UsageTotals; // GridHive consoles
  machine: { today: UsageTotals; last5h: UsageTotals; last7d: UsageTotals };
  byAccount: AccountUsage[];
  budgets: BudgetStatus[];
  jobsPaused: boolean;
}

// ---------- API-equivalent price estimates ----------
// USD per million tokens at Anthropic's public API list prices (cached 2026-10). These are ESTIMATES:
// most GridHive users are on a Claude subscription and pay nothing per token, so the UI labels
// the number "API-equivalent". Cache writes are 1.25x input (5 min) or 2x input (1 h);
// cache reads use the listed read price (0.1x input unless the model says otherwise).
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

// First match wins: specific versions before family fallbacks
export const PRICES: { match: RegExp; price: ModelPrice }[] = [
  { match: /fable-5-1|mythos-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
  { match: /fable|mythos/, price: { input: 10, output: 50, cacheRead: 1 } },
  { match: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /opus-(5|4-[5-9])/, price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: /opus/, price: { input: 15, output: 75, cacheRead: 1.5 } }, // Opus 4 / 4.1 and older
  { match: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /sonnet/, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { match: /haiku-5/, price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
  { match: /haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
  { match: /haiku/, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
];
// Unknown models are priced like Sonnet so the estimate is never silently zero
export const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.3 };

const priceCache = new Map<string, ModelPrice>();

export function priceFor(model: string): ModelPrice {
  let price = priceCache.get(model);
  if (!price) {
    const id = model.toLowerCase();
    price = PRICES.find((p) => p.match.test(id))?.price ?? FALLBACK_PRICE;
    priceCache.set(model, price);
  }
  return price;
}

export function estimateCostUsd(
  model: string,
  u: { input: number; output: number; cacheCreate: number; cacheCreate1h?: number; cacheRead: number },
): number {
  const p = priceFor(model);
  const longCache = Math.min(u.cacheCreate, u.cacheCreate1h ?? 0);
  const shortCache = u.cacheCreate - longCache;
  return (
    (u.input * p.input +
      u.output * p.output +
      shortCache * p.input * 1.25 +
      longCache * p.input * 2 +
      u.cacheRead * p.cacheRead) /
    1_000_000
  );
}

// Cache reads are cheap (a tenth of input) and dominate raw counts, so budgets use this weighting
export function weightedTokens(u: { input: number; output: number; cacheCreate: number; cacheRead: number }): number {
  return u.input + u.output + u.cacheCreate + Math.round(u.cacheRead / 10);
}

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, weighted: 0, costUsd: 0, messages: 0 };
}

// 12345 -> '12.3k', 4_500_000 -> '4.5M'
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : abs < 100_000 ? 1 : 0)}k`.replace('.0k', 'k');
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(abs < 100_000_000 ? 1 : 0)}M`.replace('.0M', 'M');
  return `${(n / 1_000_000_000).toFixed(1)}B`.replace('.0B', 'B');
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
