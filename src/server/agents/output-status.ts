import type { ConsoleStatus } from '../../shared/protocol.js';
import { parseDialog, stripAnsi } from '../prompt-detector.js';

// Status for consoles whose CLI sends us no hooks (Codex, Gemini CLI, OpenCode, custom commands),
// guessed from what the PTY prints:
// - working: output keeps arriving (spinners and "Working (12s)" timers redraw every second)
// - needs_you: a confirmation prompt is on screen (y/n, Allow/Approve, numbered Yes/No choices),
//   or the CLI announced one with a terminal notification (OSC 9, e.g. Codex "Approval requested")
// - resting: quiet for a few seconds after a prompt was submitted; idle: quiet before the first one
// Keystroke echo (a TUI redrawing its input box while you type) does not count as work.

export interface OutputStatusOptions {
  mode: 'agent' | 'custom'; // custom commands only go working/resting (no prompts, no idle)
  quietMs: number;
  echoMs: number; // output this soon after a non-Enter keystroke is its echo
  // Adapter hook for CLI-specific markers in the raw output (complete OSC sequences only)
  fromOutput?: (chunk: string) => { status: 'needs_you' | 'resting'; detail?: string } | null;
}

export const AGENT_HEURISTICS: Omit<OutputStatusOptions, 'fromOutput'> = { mode: 'agent', quietMs: 3000, echoMs: 300 };
export const CUSTOM_HEURISTICS: Omit<OutputStatusOptions, 'fromOutput'> = { mode: 'custom', quietMs: 1500, echoMs: 300 };

export const CONFIRM_DETAIL = 'Waiting for your confirmation';

const TAIL_LIMIT = 3000;
const SCREEN_LINES = 14; // only the bottom of the screen counts: answered prompts scroll away
const YES_NO = /\[y\/n\]|\(y\/n\)|\[y\/N\]|\[Y\/n\]|\(yes\/no\)|\by\/n\b/i;
const CONFIRM_TEXT =
  /Would you like to (?:run|make|grant|apply|allow)|Do you want to (?:proceed|continue|allow|run|apply|approve|make)|Allow (?:once|always|this|execution)|Approve (?:this|once|for)|Waiting for (?:user |your )?(?:approval|confirmation)|Permission required|requires? (?:your )?approval/i;
const CHOICE_LABEL = /\b(yes|no|allow|approve|deny|reject|proceed|cancel|always)\b/i;

export interface Evaluation {
  status: ConsoleStatus;
  detail?: string;
}

const RULE_LINE = /^[\s─━═╌┄╭╮╰╯┌┐└┘├┤│┃|▔▁-]*$/;
const OPTION_LINE = /^[\s│┃|]*(?:[❯›>▶●○◯☐☑✔]\s*)?\d{1,2}[.)]\s+\S/;
// Lines allowed below a prompt (key hints like "Press enter to confirm or esc to cancel")
const TRAILING_LINES = 2;

// A prompt only counts while it is the last thing on screen: Windows ConPTY repaints the visible
// screen, so an answered dialog that is still visible higher up would otherwise match again.
export function detectConfirmation(screenText: string): string | null {
  const lines = screenText.split('\n').filter((l) => l.trim() && !RULE_LINE.test(l));
  let lastOption = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 1 - TRAILING_LINES); i--) {
    if (OPTION_LINE.test(lines[i])) {
      lastOption = i;
      break;
    }
  }
  if (lastOption >= 0) {
    const dialog = parseDialog(lines.slice(Math.max(0, lastOption + 1 - SCREEN_LINES), lastOption + 1).join('\n'));
    if (dialog && dialog.options.some((o) => CHOICE_LABEL.test(o.label))) {
      // The question is often a few lines up, above the command or diff being approved
      const above = [...dialog.context, ...(dialog.question ? [dialog.question] : [])];
      const asked = [...above].reverse().find((l) => CONFIRM_TEXT.test(l) || l.trim().endsWith('?')) ?? dialog.question;
      return asked ? asked.slice(0, 160) : CONFIRM_DETAIL;
    }
  }
  for (const raw of lines.slice(-TRAILING_LINES)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (YES_NO.test(line) || CONFIRM_TEXT.test(line)) return line.slice(0, 160) || CONFIRM_DETAIL;
  }
  return null;
}

// Terminal notifications: OSC 9 ("ESC ] 9 ; message BEL"), as Codex sends with tui.notification_method=osc9
// eslint-disable-next-line no-control-regex
const OSC9 = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
export function osc9Messages(chunk: string): string[] {
  return [...chunk.matchAll(OSC9)].map((m) => m[1]);
}

export class OutputStatusTracker {
  private tail = '';
  private oscCarry = ''; // an OSC sequence split across two chunks
  private lastOutputAt = 0;
  private lastInputAt = 0;
  private lastInputSubmit = false;
  private submitted = false; // a prompt went in since launch, so quiet = resting (not idle)
  private marker: { status: 'needs_you' | 'resting'; detail?: string } | null = null;
  private needsYouShown = false;

  constructor(
    private readonly options: OutputStatusOptions,
    private readonly startedAt = Date.now(),
  ) {}

  noteInput(data: string, now = Date.now()): void {
    this.lastInputAt = now;
    this.lastInputSubmit = data.includes('\r');
    // Any key answers a confirmation (Codex takes a bare "y"); forget it so it cannot re-match
    if (this.needsYouShown || this.marker?.status === 'needs_you' || this.lastInputSubmit || data === '\x1b' || data.includes('\x03')) {
      this.tail = '';
      this.marker = null;
      this.needsYouShown = false;
    }
    if (this.lastInputSubmit) this.submitted = true;
  }

  feed(data: string, now = Date.now()): void {
    if (this.options.fromOutput) {
      const text = this.oscCarry + data;
      const open = text.lastIndexOf('\x1b]');
      const closed = open < 0 || /\x07|\x1b\\/.test(text.slice(open));
      const complete = closed ? text : text.slice(0, open);
      this.oscCarry = closed ? '' : text.slice(open).slice(-512);
      const marker = this.options.fromOutput(complete);
      if (marker) this.marker = marker;
    }
    this.tail = (this.tail + stripAnsi(data)).slice(-TAIL_LIMIT);
    const echo = this.lastInputAt > 0 && !this.lastInputSubmit && now - this.lastInputAt < this.options.echoMs;
    if (!echo) this.lastOutputAt = now;
  }

  // The status to show now, given the current one; null = leave it
  evaluate(current: ConsoleStatus, now = Date.now()): Evaluation | null {
    if (current === 'exited' || current === 'suspended') return null;
    const streaming = this.lastOutputAt > 0 && now - this.lastOutputAt < this.options.quietMs;
    if (this.options.mode === 'custom') {
      if (streaming) return { status: 'working' };
      return now - this.startedAt >= this.options.quietMs ? { status: 'resting' } : null;
    }
    if (this.marker?.status === 'needs_you') return this.needsYou(this.marker.detail ?? CONFIRM_DETAIL);
    const confirm = detectConfirmation(this.tail);
    if (confirm) return this.needsYou(confirm);
    this.needsYouShown = false;
    if (this.marker?.status === 'resting') return { status: 'resting' };
    if (streaming) return this.submitted ? { status: 'working' } : null; // start-up drawing stays 'starting'
    if (this.lastOutputAt === 0 && now - this.startedAt < this.options.quietMs) return null;
    return { status: this.submitted ? 'resting' : 'idle' };
  }

  private needsYou(detail: string): Evaluation {
    this.needsYouShown = true;
    return { status: 'needs_you', detail };
  }
}
