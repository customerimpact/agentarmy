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
}
