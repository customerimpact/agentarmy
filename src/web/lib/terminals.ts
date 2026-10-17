import type { Terminal } from '@xterm/xterm';

// Live xterm instances by console id, so non-React code (shortcuts, status cards) can reach them
const registry = new Map<string, Terminal>();

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term);
}

export function unregisterTerminal(id: string, term: Terminal): void {
  if (registry.get(id) === term) registry.delete(id);
}

export function getTerminal(id: string): Terminal | undefined {
  return registry.get(id);
}

export function focusTerminal(id: string): void {
  registry.get(id)?.focus();
}

// Last non-blank rows of the terminal as plain text, for the zoomed-out status card
export function lastLines(id: string, count: number): string[] {
  const term = registry.get(id);
  if (!term) return [];
  const buffer = term.buffer.active;
  const lines: string[] = [];
  const end = buffer.baseY + buffer.cursorY;
  for (let i = Math.min(end + 1, buffer.length - 1); i >= 0 && lines.length < count; i--) {
    if (end - i > 400) break;
    const text = buffer.getLine(i)?.translateToString(true).trimEnd() ?? '';
    if (text.trim()) lines.push(text);
  }
  return lines.reverse();
}
