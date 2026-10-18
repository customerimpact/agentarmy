import { cycleTheme } from './theme';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

// Shift+T cycles color themes (Shift+Alt+T backwards). Ignored while typing in a field or terminal.
export function installThemeShortcut(): void {
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyT' || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    cycleTheme(e.altKey ? -1 : 1);
  });
}
