import type { AgentKind } from '../shared/agents.js';
import { parseResetTime } from './limit-parser.js';
import { stripAnsi } from './prompt-detector.js';

// Plan / rate-limit messages of the non-Claude CLIs, read from their terminal output (best effort;
// Claude Code's own messages are in limit-parser.ts). Only clear "you are out of quota" wording counts,
// never a bare "429" or "rate limit" in the middle of an agent's reply.
//
// Codex (strings in the codex-cli 0.142.5 binary, 2026-10-19):
//   "You've hit your usage limit. Upgrade to Plus to continue using Codex (...), or try again at 3:45 PM."
//   "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"
//   "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex."
//   "Your workspace is out of credits. Add credits to continue using Codex."
// Gemini CLI (its quota error texts, not run here): "You have reached your daily quota limit",
//   "Quota exceeded for quota metric '...'", "Usage limit reached for all Pro models", RESOURCE_EXHAUSTED.
// Grok Build / OpenCode (no documented wording): API errors such as "429 Too Many Requests: rate limit
//   reached" or "insufficient credits" on an error line.

export interface AgentLimitInfo {
  label: string; // human words, e.g. 'Codex usage limit'
  resetsAt?: number; // epoch ms
  text: string; // the matched line
}

interface Pattern {
  re: RegExp;
  label: string;
}

const LABEL: Partial<Record<AgentKind, string>> = {
  codex: 'Codex usage limit',
  gemini: 'Gemini quota',
  grok: 'Grok rate limit',
  opencode: 'OpenCode provider limit',
};

const CODEX: RegExp[] = [
  /You[’']?ve\s+hit\s+your\s+usage\s+limit\b[^\n]*/i,
  /Usage\s+limit\s+reached\.\s+You[’']?ve\s+reached\s+your\s+usage\s+limit[^\n]*/i,
  /Your\s+workspace\s+is\s+out\s+of\s+credits[^\n]*/i,
];
const GEMINI: RegExp[] = [
  /You\s+have\s+(?:reached|exhausted)\s+your\s+daily\s+(?:[\w.-]+\s+)?quota[^\n]*/i,
  /Quota\s+exceeded\s+for\s+quota\s+metric[^\n]*/i,
  /Usage\s+limit\s+reached\s+for\s+all\s+[^\n]*models[^\n]*/i,
  /\bRESOURCE_EXHAUSTED\b[^\n]*/,
];
// An error line, not prose: starts with an error marker and names the limit
const API_ERRORS: RegExp[] = [
  /^[\s■✗✕×!⚠]*(?:error|api error|request failed)\b[^\n]*(?:429|too many requests|rate[ _-]?limit(?:ed| reached| exceeded)?|insufficient (?:credits|quota)|out of credits)[^\n]*/im,
];

const PATTERNS: Partial<Record<AgentKind, RegExp[]>> = {
  codex: [...CODEX, ...API_ERRORS],
  gemini: [...GEMINI, ...API_ERRORS],
  grok: API_ERRORS,
  opencode: API_ERRORS,
};

const RESET = /(?:try\s+again|resets?|available\s+again)\s+(?:at\s+)?(in\s+(?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+|[^\n.]*?[ap]\.?m\.?(?:\s*\([^)\n]+\))?)/i;

function clean(text: string): string {
  return stripAnsi(text).replace(/[ \t ]+/g, ' ');
}

// The newest limit message in this CLI's output, or null (Claude / custom: always null)
export function parseAgentLimitText(agent: AgentKind, raw: string, now = Date.now()): AgentLimitInfo | null {
  const patterns: Pattern[] = (PATTERNS[agent] ?? []).map((re) => ({ re, label: LABEL[agent] ?? 'usage limit' }));
  if (!patterns.length) return null;
  const text = clean(raw);
  let best: { info: AgentLimitInfo; end: number } | null = null;
  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const line = m[0].trim();
      const info: AgentLimitInfo = { label: p.label, text: line.slice(0, 240) };
      const reset = RESET.exec(line);
      if (reset) {
        const at = parseResetTime(reset[1].replace(/\s+and\s+/g, ' ').replace(/,/g, ' ').trim(), now);
        if (at) info.resetsAt = at;
      }
      const end = m.index + m[0].length;
      if (!best || end > best.end) best = { info, end };
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return best?.info ?? null;
}
