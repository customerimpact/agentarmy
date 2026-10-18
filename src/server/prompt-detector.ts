// Some Claude Code dialogs (folder trust, post-turn menus) fire no hook, so we spot them in the output

const TAIL_LIMIT = 4000;

export const TRUST_DETAIL = 'Trust this folder?';
export const QUESTION_DETAIL = 'Claude is asking a question';

// Ink lays out text with cursor moves instead of spaces, so turn those into whitespace first
export function stripAnsi(data: string): string {
  return (
    data
      // OSC (titles, hyperlinks) ending in BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // cursor forward / horizontal moves become a space; vertical moves become a newline
      .replace(/\x1b\[\d*[CG`]/g, ' ')
      .replace(/\x1b\[\d*(?:;\d*)?[ABEFHf]/g, '\n')
      // every other CSI sequence (colors, erase, modes)
      .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
      // two-character escapes (ESC 7, ESC =, ...)
      .replace(/\x1b[@-Z\\-_78=>]/g, '')
      .replace(/\r/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

export function detectPrompt(text: string): string | null {
  if (/trust\s*this\s*folder/i.test(text)) return TRUST_DETAIL;
  if (/Enter\s*to\s*confirm/i.test(text)) return QUESTION_DETAIL;
  return null;
}

// Keys that answer or dismiss a dialog; arrow keys and typing only move inside it
export function isDismissInput(data: string): boolean {
  return data.includes('\r') || data === '\x1b' || data.includes('\x03');
}

export class PromptDetector {
  private tail = '';

  feed(data: string): void {
    this.tail = (this.tail + stripAnsi(data)).slice(-TAIL_LIMIT);
  }

  // Forget what was on screen, e.g. after a dismiss key or a hook, so old text cannot re-match
  reset(): void {
    this.tail = '';
  }

  detect(): string | null {
    return detectPrompt(this.tail);
  }

  dialog(): ParsedDialog | null {
    return parseDialog(this.tail);
  }
}

// ---------- Dialog options (answer from the inbox) ----------
// Claude Code dialogs list numbered choices; pressing the digit picks one. We read the last such
// list on screen so the Actions tab can offer the same choices as buttons.

export interface DialogOption {
  key: string; // keystroke that picks it, e.g. '1'
  label: string;
}

export interface ParsedDialog {
  question?: string;
  options: DialogOption[];
  allowText: boolean; // one option takes a typed answer ("tell Claude what to do", "Type something")
  textKey?: string; // the option to press before typing that answer
  context: string[]; // a few screen lines above the question
}

const OPTION_LINE = /^[\s│┃|]*(?:[❯›>▶●○◯☐☑✔]\s*)?(\d{1,2})[.)]\s+(.+?)[\s│┃|]*$/;
const RULE_LINE = /^[\s─━═╌┄╭╮╰╯┌┐└┘├┤│┃|▔▁-]*$/;
const HINT_LINE = /(Enter to|Esc to|↑\/↓|Tab to|ctrl\+)/i;
const TEXT_OPTION = /(tell Claude what to do|type something|type your own|something else|^other\b)/i;
const DIALOG_WINDOW = 14; // the list must end within this many non-empty lines of the bottom
const MAX_GAP = 3; // description lines allowed between two options
const CONTEXT_LINES = 6;

function cleanLine(line: string): string {
  return line.replace(/^[\s│┃|]+|[\s│┃|]+$/g, '').replace(/\s+/g, ' ');
}

export function parseDialog(text: string): ParsedDialog | null {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !RULE_LINE.test(l));
  const windowStart = Math.max(0, lines.length - DIALOG_WINDOW);
  // The last "1." in the window starts the newest list (Ink redraws leave older copies above)
  let first = -1;
  for (let i = lines.length - 1; i >= windowStart; i--) {
    const m = OPTION_LINE.exec(lines[i]);
    if (m && m[1] === '1') {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  const options: DialogOption[] = [];
  let gap = 0;
  for (let i = first; i < lines.length; i++) {
    const m = OPTION_LINE.exec(lines[i]);
    if (m && Number(m[1]) === options.length + 1) {
      options.push({ key: m[1], label: cleanLine(m[2]) });
      gap = 0;
      continue;
    }
    if (HINT_LINE.test(lines[i]) || ++gap > MAX_GAP) break;
  }
  if (options.length < 2) return null;
  const above = lines.slice(Math.max(0, first - CONTEXT_LINES - 1), first).map(cleanLine).filter(Boolean);
  const question = above.pop();
  const textOption = options.find((o) => TEXT_OPTION.test(o.label));
  return {
    ...(question ? { question } : {}),
    options,
    allowText: !!textOption,
    ...(textOption ? { textKey: textOption.key } : {}),
    context: above,
  };
}

export function sameDialog(a: ParsedDialog | null, b: ParsedDialog | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
