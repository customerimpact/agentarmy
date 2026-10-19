import { describe, expect, it } from 'vitest';
import { parseAgentLimitText } from './agent-limits.js';

const NOW = new Date(2026, 9, 19, 14, 0).getTime(); // local 2pm

describe('parseAgentLimitText', () => {
  it('reads Codex usage-limit errors and their reset time', () => {
    const hit = parseAgentLimitText(
      'codex',
      "\x1b[31m■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:45 PM.\x1b[0m",
      NOW,
    );
    expect(hit).toMatchObject({ label: 'Codex usage limit' });
    expect(hit?.resetsAt).toBe(new Date(2026, 9, 19, 15, 45).getTime());
    const rel = parseAgentLimitText('codex', "You've hit your usage limit. Try again in 2 days 3 hours 4 minutes.", NOW);
    expect(rel?.resetsAt).toBe(NOW + ((2 * 24 + 3) * 60 + 4) * 60_000);
    expect(parseAgentLimitText('codex', 'Usage limit reached. You\'ve reached your usage limit. Increase your limits to continue using codex.', NOW)).not.toBeNull();
    expect(parseAgentLimitText('codex', 'Your workspace is out of credits. Add credits to continue using Codex.', NOW)).not.toBeNull();
  });

  it('reads Gemini CLI quota errors', () => {
    expect(parseAgentLimitText('gemini', 'You have reached your daily gemini-2.5-pro quota limit.', NOW)?.label).toBe('Gemini quota');
    expect(parseAgentLimitText('gemini', "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests'", NOW)).not.toBeNull();
    expect(parseAgentLimitText('gemini', 'Usage limit reached for all Pro models.', NOW)).not.toBeNull();
  });

  it('reads API error lines from Grok / OpenCode, with a relative reset', () => {
    const hit = parseAgentLimitText('grok', 'Error: 429 Too Many Requests: rate limit reached for grok-build. Try again in 1h.', NOW);
    expect(hit?.label).toBe('Grok rate limit');
    expect(hit?.resetsAt).toBe(NOW + 60 * 60_000);
    expect(parseAgentLimitText('opencode', 'API error: insufficient credits for xai/grok-4', NOW)).not.toBeNull();
  });

  it('ignores prose that merely mentions limits, and Claude / custom consoles', () => {
    expect(parseAgentLimitText('grok', 'I added a rate limit of 429 responses per minute to the API.', NOW)).toBeNull();
    expect(parseAgentLimitText('codex', 'The usage limit middleware is done.', NOW)).toBeNull();
    expect(parseAgentLimitText('claude', "You've hit your usage limit", NOW)).toBeNull();
    expect(parseAgentLimitText('custom', 'Error: 429 Too Many Requests', NOW)).toBeNull();
  });
});
