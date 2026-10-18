import { describe, expect, it } from 'vitest';
import { formatReset, limitFromHook, parseLimitText, parseResetTime } from './limit-parser.js';

// 2026-10-18 14:00 in Brussels (CEST, UTC+2) = 12:00 UTC
const NOW = Date.UTC(2026, 9, 18, 12, 0);
const BXL = 'Europe/Brussels';

describe('parseResetTime', () => {
  it('reads a time today in the given zone', () => {
    expect(parseResetTime('3pm (Europe/Brussels)', NOW)).toBe(Date.UTC(2026, 9, 18, 13, 0));
    expect(parseResetTime('3:30pm', NOW, BXL)).toBe(Date.UTC(2026, 9, 18, 13, 30));
  });

  it('rolls a time that already passed to tomorrow', () => {
    expect(parseResetTime('11am (Europe/Brussels)', NOW)).toBe(Date.UTC(2026, 9, 19, 9, 0));
  });

  it('reads month, day and optional year', () => {
    expect(parseResetTime('Oct 20, 11pm (Europe/Brussels)', NOW)).toBe(Date.UTC(2026, 9, 20, 21, 0));
    expect(parseResetTime('Jan 2, 2027, 3pm (UTC)', NOW)).toBe(Date.UTC(2027, 0, 2, 15, 0));
    // "Jan 2" seen in October means next January
    expect(parseResetTime('Jan 2, 3pm (UTC)', NOW)).toBe(Date.UTC(2027, 0, 2, 15, 0));
  });

  it('handles DST: Nov 2 in Brussels is UTC+1', () => {
    expect(parseResetTime('Nov 2, 9am (Europe/Brussels)', NOW)).toBe(Date.UTC(2026, 10, 2, 8, 0));
  });

  it('reads relative times and ISO stamps', () => {
    expect(parseResetTime('in 2h 30m', NOW)).toBe(NOW + 2.5 * 3600_000);
    expect(parseResetTime('in 45 minutes', NOW)).toBe(NOW + 45 * 60_000);
    expect(parseResetTime('2026-10-20T21:00:00Z', NOW)).toBe(Date.UTC(2026, 9, 20, 21));
  });

  it('ignores an unknown zone and junk', () => {
    expect(parseResetTime('3pm (Mars/Olympus)', NOW, 'UTC')).toBe(Date.UTC(2026, 9, 18, 15));
    expect(parseResetTime('soon', NOW)).toBeUndefined();
    expect(parseResetTime('13pm', NOW)).toBeUndefined();
  });
});

describe('parseLimitText', () => {
  it('weekly warning with percent and reset', () => {
    const r = parseLimitText("You've used 95% of your weekly limit · resets Oct 20, 11pm (Europe/Brussels)", NOW);
    expect(r).toMatchObject({ kind: 'warning', window: 'weekly', percent: 95, resetsAt: Date.UTC(2026, 9, 20, 21) });
  });

  it('session limit hit (current wording)', () => {
    const r = parseLimitText("You've hit your session limit · resets 3pm (Europe/Brussels)", NOW);
    expect(r).toMatchObject({ kind: 'hit', window: 'session', label: 'session limit', resetsAt: Date.UTC(2026, 9, 18, 13) });
  });

  it('older wordings', () => {
    expect(parseLimitText('5-hour limit reached ∙ resets 3pm', NOW)).toMatchObject({ kind: 'hit', window: 'session' });
    expect(parseLimitText('Opus weekly limit reached ∙ resets Oct 21, 9am', NOW)).toMatchObject({ kind: 'hit', window: 'opus' });
    expect(parseLimitText("You've hit your limit · resets 3pm", NOW)).toMatchObject({ kind: 'hit', window: 'usage' });
    expect(parseLimitText('Claude usage limit reached. Your limit will reset at 5pm (UTC).', NOW)).toMatchObject({
      kind: 'hit',
      resetsAt: Date.UTC(2026, 9, 18, 17),
    });
    expect(parseLimitText('Claude AI usage limit reached|1792364400', NOW)).toMatchObject({
      kind: 'hit',
      resetsAt: 1792364400 * 1000,
    });
    expect(parseLimitText('Usage limit reached · limit resets 3pm (UTC)', NOW)).toMatchObject({ kind: 'hit', resetsAt: Date.UTC(2026, 9, 18, 15) });
  });

  it('approaching warning without a percent', () => {
    expect(parseLimitText('Approaching session limit · resets 3pm', NOW)).toMatchObject({ kind: 'warning', window: 'session' });
  });

  it('sees through ANSI colors and cursor-move spaces', () => {
    const raw = "\x1b[31mYou've\x1b[1Chit\x1b[1Cyour\x1b[1Cweekly\x1b[1Climit\x1b[39m \x1b[2m·\x1b[22m resets\x1b[1COct\x1b[1C20,\x1b[1C11pm\x1b[1C(Europe/Brussels)\r\n";
    expect(parseLimitText(raw, NOW)).toMatchObject({ kind: 'hit', window: 'weekly', resetsAt: Date.UTC(2026, 9, 20, 21) });
  });

  it('newest message wins', () => {
    const text = "You've used 90% of your session limit · resets 3pm\nlater\nYou've hit your session limit · resets 3pm";
    expect(parseLimitText(text, NOW)?.kind).toBe('hit');
  });

  it('does not take other limits for plan limits', () => {
    expect(parseLimitText('Context limit reached · /compact or /clear to continue', NOW)).toBeNull();
    expect(parseLimitText('Subagent nesting limit reached (depth 3 of 3)', NOW)).toBeNull();
    expect(parseLimitText('Budget limit reached ($5.00 of $5)', NOW)).toBeNull();
    expect(parseLimitText('rate limited · retrying in 3s', NOW)).toBeNull();
  });
});

describe('limitFromHook', () => {
  it('StopFailure with the banner text', () => {
    const r = limitFromHook(
      { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 3pm (UTC)" },
      NOW,
    );
    expect(r).toMatchObject({ kind: 'hit', window: 'session', resetsAt: Date.UTC(2026, 9, 18, 15) });
  });

  it('bare rate_limit StopFailure counts as a hit', () => {
    expect(limitFromHook({ hook_event_name: 'StopFailure', error: 'rate_limit' }, NOW)).toMatchObject({ kind: 'hit', window: 'usage' });
  });

  it('other failures and Stop do not', () => {
    expect(limitFromHook({ hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: overloaded' }, NOW)).toBeNull();
    expect(limitFromHook({ hook_event_name: 'Stop', last_assistant_message: "You've hit your session limit" }, NOW)).toBeNull();
  });

  it('Notification messages', () => {
    expect(limitFromHook({ hook_event_name: 'Notification', message: "You've used 80% of your weekly limit" }, NOW)).toMatchObject({
      kind: 'warning',
      percent: 80,
    });
  });
});

describe('formatReset', () => {
  it('short words', () => {
    const now = new Date(2026, 9, 18, 10, 0).getTime();
    expect(formatReset(new Date(2026, 9, 18, 23, 0).getTime(), now)).toBe('11pm');
    expect(formatReset(new Date(2026, 9, 20, 15, 30).getTime(), now)).toBe('Oct 20, 3:30pm');
  });
});
