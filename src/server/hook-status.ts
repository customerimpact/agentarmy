import type { ConsoleStatus } from '../shared/protocol.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  notification_type?: string;
  message?: string;
  error?: unknown;
  last_assistant_message?: unknown;
  [key: string]: unknown;
}

export interface StatusUpdate {
  status?: ConsoleStatus;
  statusDetail?: string;
  sessionId?: string;
}

const NEEDS_YOU_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// Returns null when the event should not change anything we show.
export function statusFromHook(payload: HookPayload): StatusUpdate | null {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return {
        status: 'idle',
        ...(text(payload.session_id) ? { sessionId: payload.session_id } : {}),
      };
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return { status: 'working' };
    case 'Notification': {
      const kind = text(payload.notification_type);
      if (kind && NEEDS_YOU_NOTIFICATIONS.has(kind)) {
        return { status: 'needs_you', statusDetail: text(payload.message) ?? kind };
      }
      if (kind === 'idle_prompt') return { status: 'resting' };
      return null;
    }
    case 'Stop':
      return { status: 'resting' };
    case 'StopFailure':
      return {
        status: 'error',
        statusDetail:
          text(payload.last_assistant_message) ?? text(payload.error) ?? 'The turn failed',
      };
    default:
      // SessionEnd stays as-is until the PTY actually exits
      return null;
  }
}
