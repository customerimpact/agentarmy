import { stripAnsi } from './prompt-detector.js';
import type { HookPayload } from './hook-status.js';

// Reads Claude Code's plan-limit messages from terminal output and hook payloads.
//
// Templates verified in the Claude Code 2.1.302 binary (2026-10-18):
// - warning: `You've used ${pct}% of your ${name}` + ` · resets ${time}` (or `Approaching ${name}`)
// - hit:     `You've hit your ${name}` + ` · resets ${time}`, `You've reached your Fable limit`
// - names:   five_hour "session limit", seven_day "weekly limit", "Opus limit", "Sonnet limit",
//            "Fable limit", "usage credit limit"
// - also:    "Usage limit reached · limit resets ${time}"
// - time:    "3pm", "3:30pm", "Oct 20, 11pm", "Jan 2, 2027, 3pm", optionally " (Europe/Brussels)"
// Older versions printed "5-hour limit reached ∙ resets 3pm", "Claude usage limit reached. Your limit
// will reset at 3pm (Europe/Brussels)." and wrote "Claude AI usage limit reached|<unix seconds>".

export type LimitWindow = 'session' | 'weekly' | 'opus' | 'sonnet' | 'fable' | 'credits' | 'usage';

export interface LimitInfo {
  kind: 'hit' | 'warning';
  window: LimitWindow;
  label: string; // human words, e.g. 'session limit'
  percent?: number; // warnings: share of the limit used
  resetsAt?: number; // epoch ms
  text: string; // the matched line, for status details
}

const LABELS: Record<LimitWindow, string> = {
  session: 'session limit',
  weekly: 'weekly limit',
  opus: 'Opus limit',
  sonnet: 'Sonnet limit',
  fable: 'Fable limit',
  credits: 'usage credit limit',
  usage: 'usage limit',
};

function windowOf(name: string): LimitWindow {
  const n = name.toLowerCase();
  if (/session|5-?\s?hour|five/.test(n)) return 'session';
  if (/opus/.test(n)) return 'opus';
  if (/sonnet/.test(n)) return 'sonnet';
  if (/fable/.test(n)) return 'fable';
  if (/credit/.test(n)) return 'credits';
  if (/week/.test(n)) return 'weekly';
  return 'usage';
}

// ---------- reset times ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

interface Wall {
  year: number;
  month: number; // 0-11
  day: number;
  hour: number;
  minute: number;
}

function wallIn(ms: number, tz?: string): Wall {
  if (!tz) {
    const d = new Date(ms);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

// Wall-clock time in a zone (or local time) -> epoch ms. Day overflow (day 32) rolls over like Date.UTC.
function wallToMs(w: Wall, tz?: string): number {
  if (!tz) return new Date(w.year, w.month, w.day, w.hour, w.minute).getTime();
  const guess = Date.UTC(w.year, w.month, w.day, w.hour, w.minute);
  const offsetAt = (ms: number): number => {
    const x = wallIn(ms, tz);
    return Date.UTC(x.year, x.month, x.day, x.hour, x.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = guess - offsetAt(guess);
  const second = guess - offsetAt(first);
  return second;
}

// "3pm", "3:30 pm", "Oct 20, 11pm", "Jan 2, 2027, 3pm", "in 2h 30m", "2026-10-20T21:00:00Z"
export function parseResetTime(raw: string, now = Date.now(), zone?: string): number | undefined {
  let text = raw.trim();
  let tz = validZone(zone);
  const tzMatch = /\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*|UTC|GMT)\)\s*\.?$/.exec(text);
  if (tzMatch) {
    tz = validZone(tzMatch[1]) ?? tz;
    text = text.slice(0, tzMatch.index).trim();
  }
  const rel = /^in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    return now + Number(rel[1] ?? 0) * DAY_MS + Number(rel[2] ?? 0) * HOUR_MS + Number(rel[3] ?? 0) * 60_000;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const iso = Date.parse(text);
    return Number.isFinite(iso) ? iso : undefined;
  }
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i.exec(text);
  if (!m) return undefined;
  if (Number(m[4]) < 1 || Number(m[4]) > 12) return undefined;
  let hour = Number(m[4]) % 12;
  if (m[6].toLowerCase() === 'p') hour += 12;
  const minute = Number(m[5] ?? 0);
  if (hour > 23 || minute > 59) return undefined;
  const today = wallIn(now, tz);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return undefined;
    const day = Number(m[2]);
    const explicitYear = m[3] ? Number(m[3]) : undefined;
    let at = wallToMs({ year: explicitYear ?? today.year, month, day, hour, minute }, tz);
    // "Jan 2" printed in late December means next year
    if (!explicitYear && at < now - 2 * DAY_MS) at = wallToMs({ year: today.year + 1, month, day, hour, minute }, tz);
    return at;
  }
  let at = wallToMs({ ...today, hour, minute }, tz);
  if (at <= now) at = wallToMs({ ...today, day: today.day + 1, hour, minute }, tz);
  return at;
}

// ---------- messages ----------

const SEP = String.raw`[·∙•|\-–—]`;
const QUALIFIER = String.raw`(?:session|weekly|week|5-?\s?hour|opus(?:\s+weekly)?|sonnet(?:\s+weekly)?|fable|usage\s+credit|usage)`;
const NAME_OPT = String.raw`(?<name>(?:${QUALIFIER}\s+)?limit)`; // "your limit" (older) or "your weekly limit"
const NAME_REQ = String.raw`(?<name>${QUALIFIER}\s+limit)`; // "... limit reached" needs a qualifier: "Context limit reached" is not one
const RESET = String.raw`(?:\s*${SEP}?\s*(?:limit\s+)?resets?\s+(?:at\s+)?(?<reset>in\s+(?:\d+\s*[dhm][a-z]*\s*)+|[^·∙•|\n]*?[ap]\.?m\.?(?:\s*\([^)\n]+\))?))?`;
const WILL_RESET = /limit\s+will\s+reset\s+(?:at\s+)?([^.\n]*?[ap]\.?m\.?(?:\s*\([^)\n]+\))?)/i;

const PATTERNS: { re: RegExp; kind: LimitInfo['kind'] }[] = [
  { re: new RegExp(String.raw`You[’']?ve\s*used\s*(?<pct>\d{1,3})\s*%\s*of\s*your\s*${NAME_OPT}${RESET}`, 'gi'), kind: 'warning' },
  { re: new RegExp(String.raw`Approaching\s+(?:your\s+)?${NAME_OPT}${RESET}`, 'gi'), kind: 'warning' },
  { re: new RegExp(String.raw`You[’']?ve\s*(?:hit|reached)\s*your\s*${NAME_OPT}${RESET}`, 'gi'), kind: 'hit' },
  { re: new RegExp(String.raw`${NAME_REQ}\s+reached${RESET}`, 'gi'), kind: 'hit' },
  { re: /(?<legacy>Claude(?:\s+AI)?\s+usage\s+limit)\s+reached(?:\|(?<epoch>\d{9,11}))?/gi, kind: 'hit' },
];

function clean(text: string): string {
  // Ink draws spaces as cursor moves; stripAnsi turns those into spaces, so squeeze runs of them
  return stripAnsi(text).replace(/[ 	 ]+/g, ' ');
}

// The last limit message in the text (newest wins), or null
export function parseLimitText(raw: string, now = Date.now()): LimitInfo | null {
  const text = clean(raw);
  let best: (LimitInfo & { index: number }) | null = null;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      const g = m.groups ?? {};
      const window = g.legacy ? 'usage' : windowOf(g.name ?? '');
      const info: LimitInfo & { index: number } = {
        kind: p.kind,
        window,
        label: LABELS[window],
        text: m[0].trim(),
        index: m.index + m[0].length,
      };
      if (g.pct) info.percent = Math.min(100, Number(g.pct));
      if (g.epoch) info.resetsAt = Number(g.epoch) * 1000;
      else if (g.reset) info.resetsAt = parseResetTime(g.reset, now);
      else if (g.legacy) {
        const will = WILL_RESET.exec(text.slice(m.index, m.index + 200));
        if (will) info.resetsAt = parseResetTime(will[1], now);
      }
      // index = where the match ends; at the same spot a hit beats a warning, and a known reset time wins
      const better =
        !best ||
        info.index > best.index ||
        (info.index === best.index && (info.kind === 'hit') > (best.kind === 'hit')) ||
        (info.index === best.index && info.kind === best.kind && !!info.resetsAt && !best.resetsAt);
      if (better) best = info;
    }
  }
  if (!best) return null;
  const { index: _index, ...info } = best;
  return info;
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

// StopFailure (error 'rate_limit', or a limit message) and Notification payloads
export function limitFromHook(payload: HookPayload, now = Date.now()): LimitInfo | null {
  const event = payload.hook_event_name;
  // Stop is a turn that worked, so a limit quoted in its reply is not a limit hit
  if (event !== 'StopFailure' && event !== 'Notification') return null;
  const text = [payload.last_assistant_message, payload.message, payload.error, (payload as Record<string, unknown>).error_details]
    .map(str)
    .filter(Boolean)
    .join('\n');
  const parsed = text ? parseLimitText(text, now) : null;
  if (parsed) return parsed;
  if (event !== 'StopFailure') return null;
  const error = str(payload.error).toLowerCase();
  // 'rate_limit' is what Claude Code reports for a used-up plan limit; "overloaded" is a server problem
  if (/rate[_\s-]?limit|usage[_\s-]?limit/.test(error) && !/overload/.test(text.toLowerCase())) {
    return { kind: 'hit', window: 'usage', label: LABELS.usage, text: text.trim() || 'rate_limit' };
  }
  return null;
}

// Short words for the reset time in toasts and status details: "11pm" or "Oct 20, 11pm"
export function formatReset(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true })
    .replace(/\s?([AP]M)/, (_m, x: string) => x.toLowerCase());
  if (ms - now < 20 * HOUR_MS && d.getDate() === new Date(now).getDate()) return time;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}
