import type { Loop, LoopGoal, LoopStop, LoopTarget, LoopTrigger } from './protocol.js';

// Loop helpers shared by the server scheduler (src/server/loops.ts) and the Loops modal.

export const LOOP_MIN_EVERY_MINUTES = 5;
export const LOOP_MAX_EVERY_MINUTES = 120;
export const LOOP_SCHEDULE_PRESETS = [5, 10, 15, 30, 60, 120];
export const LOOP_MIN_IDLE_SECONDS = 5;
export const LOOP_MAX_IDLE_SECONDS = 86_400;

export type OutputMatcher = (text: string) => boolean;

// "/regex/flags" is a regular expression; anything else matches as plain, case-insensitive text.
// Throws on an invalid regular expression.
export function compileMatcher(match: string): OutputMatcher {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(match.trim());
  if (re) {
    const flags = re[2].replace(/[gy]/g, '');
    const regex = new RegExp(re[1], flags);
    return (text) => regex.test(text);
  }
  const needle = match.toLowerCase();
  return (text) => needle.length > 0 && text.toLowerCase().includes(needle);
}

export function matcherError(match: string): string | null {
  try {
    compileMatcher(match);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// The agent's verdict at the end of its reply: true = GOAL MET, false = GOAL NOT MET, null = neither.
// The last mention wins, so quoting the instruction earlier in the reply does not count.
export function parseGoalVerdict(text: string | undefined | null): boolean | null {
  if (!text) return null;
  const matches = [...text.toUpperCase().matchAll(/GOAL\s+(NOT\s+)?MET/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return !last[1];
}

export function goalInstruction(loopName: string, goal: Extract<LoopGoal, { kind: 'agent' }>): string {
  const what = goal.description?.trim() || 'the goal of this loop is reached';
  return (
    `[GridHive loop "${loopName}"] When you finish, end your reply with the exact words ` +
    `"GOAL MET" if ${what}, otherwise end it with "GOAL NOT MET".`
  );
}

// What actually gets typed into a target console for one run
export function loopPromptText(loop: Pick<Loop, 'name' | 'prompt' | 'stop'>): string {
  const goal = loop.stop.whenGoal;
  if (goal?.kind !== 'agent') return loop.prompt;
  return `${loop.prompt}\n\n${goalInstruction(loop.name, goal)}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function formatMinutes(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

export interface LoopNames {
  console: (id: string) => string | undefined;
  project: (id: string) => string | undefined;
}

export function targetLabel(target: LoopTarget, names: LoopNames): string {
  switch (target.kind) {
    case 'all':
      return 'every console';
    case 'project':
      return names.project(target.id) ?? 'a closed project';
    case 'consoles': {
      const list = target.ids.map((id) => names.console(id)).filter((n): n is string => !!n);
      if (!list.length) return 'no console';
      if (list.length <= 3) return list.join(', ');
      return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
    }
  }
}

export function triggerLabel(trigger: LoopTrigger): string {
  switch (trigger.kind) {
    case 'schedule':
      return `Every ${formatMinutes(trigger.everyMinutes)}`;
    case 'idle':
      return `After ${formatSeconds(trigger.afterSeconds)} idle`;
    case 'output': {
      const isRegex = /^\/.+\/[a-z]*$/s.test(trigger.match.trim());
      return isRegex ? `When output matches ${trigger.match.trim()}` : `When output contains '${clip(trigger.match, 30)}'`;
    }
  }
}

export function stopLabel(stop: LoopStop): string {
  const parts: string[] = [];
  const goal = stop.whenGoal;
  if (goal) {
    const desc = goal.description?.trim();
    if (desc) parts.push(`until ${desc}`);
    else if (goal.kind === 'command') parts.push(`until \`${clip(goal.command, 40)}\` passes`);
    else parts.push('until the agent says the goal is met');
  }
  if (stop.afterRuns) parts.push(`at most ${stop.afterRuns} ${stop.afterRuns === 1 ? 'time' : 'times'}`);
  if (stop.afterMinutes) parts.push(`for ${formatMinutes(stop.afterMinutes)}`);
  return parts.join(', ');
}

// "Every 15 min, send 'Run the tests' to Frontend until tests pass"
export function loopSummary(
  loop: Pick<Loop, 'prompt' | 'target' | 'trigger' | 'stop'>,
  names: LoopNames,
): string {
  const prompt = clip(loop.prompt, 48) || '…';
  const stop = stopLabel(loop.stop);
  return `${triggerLabel(loop.trigger)}, send '${prompt}' to ${targetLabel(loop.target, names)}${stop ? ` ${stop}` : ''}`;
}
