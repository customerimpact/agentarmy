import { describe, expect, it } from 'vitest';
import { statusFromHook } from './hook-status.js';
import { buildHookSettings, hookUrl } from './hook-settings.js';

describe('statusFromHook', () => {
  it('maps SessionStart to idle and picks up the new session id', () => {
    expect(statusFromHook({ hook_event_name: 'SessionStart', session_id: 'abc' })).toEqual({
      status: 'idle',
      sessionId: 'abc',
    });
  });

  it.each(['UserPromptSubmit', 'PreToolUse', 'PostToolUse'])('maps %s to working', (event) => {
    expect(statusFromHook({ hook_event_name: event })).toEqual({ status: 'working' });
  });

  it.each(['permission_prompt', 'elicitation_dialog', 'agent_needs_input'])(
    'maps Notification %s to needs_you with the message',
    (kind) => {
      expect(
        statusFromHook({
          hook_event_name: 'Notification',
          notification_type: kind,
          message: 'Allow Bash?',
        }),
      ).toEqual({ status: 'needs_you', statusDetail: 'Allow Bash?' });
    },
  );

  it('maps Notification idle_prompt to resting', () => {
    expect(
      statusFromHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
    ).toEqual({ status: 'resting' });
  });

  it('ignores unrelated notifications', () => {
    expect(
      statusFromHook({ hook_event_name: 'Notification', notification_type: 'auth_success' }),
    ).toBeNull();
  });

  it('maps Stop to resting and StopFailure to error', () => {
    expect(statusFromHook({ hook_event_name: 'Stop' })).toEqual({ status: 'resting' });
    expect(statusFromHook({ hook_event_name: 'StopFailure', error: 'rate_limit' })).toEqual({
      status: 'error',
      statusDetail: 'rate_limit',
    });
    expect(
      statusFromHook({
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        last_assistant_message: 'API Error: Rate limit reached',
      }),
    ).toEqual({ status: 'error', statusDetail: 'API Error: Rate limit reached' });
  });

  it('leaves the status alone on SessionEnd and unknown events', () => {
    expect(statusFromHook({ hook_event_name: 'SessionEnd' })).toBeNull();
    expect(statusFromHook({ hook_event_name: 'Whatever' })).toBeNull();
    expect(statusFromHook({})).toBeNull();
  });
});

describe('buildHookSettings', () => {
  it('registers an http hook for every tracked event', () => {
    const url = hookUrl(4317, 'c1', 't/k');
    expect(url).toBe('http://127.0.0.1:4317/hook/c1?token=t%2Fk');
    const settings = buildHookSettings(url, { node: 'C:\\node.exe', script: 'C:\\fwd.cjs' });
    expect(Object.keys(settings.hooks)).toContain('StopFailure');
    expect(settings.hooks.Stop).toEqual([
      { matcher: '', hooks: [{ type: 'http', url, timeout: 5 }] },
    ]);
  });

  it('relays SessionStart through an exec-form command hook, which http does not support', () => {
    const url = hookUrl(4317, 'c1', 'tok');
    const settings = buildHookSettings(url, { node: 'C:\\node.exe', script: 'C:\\fwd.cjs' });
    expect(settings.hooks.SessionStart).toEqual([
      {
        matcher: '',
        hooks: [
          { type: 'command', command: 'C:\\node.exe', args: ['C:\\fwd.cjs', url], timeout: 5 },
        ],
      },
    ]);
  });
});
