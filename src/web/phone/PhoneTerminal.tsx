import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { terminalTheme, useTheme } from '../lib/theme';
import { phoneSocket } from './phone-api';

// Mirror of a console's terminal. The PTY keeps the size the computer's board gave it, so the
// phone uses the same columns and a small font, and scrolls sideways when the screen is narrow.
export function PhoneTerminal({ consoleId }: { consoleId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 10,
      lineHeight: 1.1,
      cols: 100,
      rows: 40,
      scrollback: 3000,
      disableStdin: true,
      cursorBlink: false,
      theme: terminalTheme(theme),
    });
    term.open(host.current);
    termRef.current = term;
    const detach = phoneSocket.attach(consoleId, (kind, data, size) => {
      if (kind === 'replay') {
        term.reset();
        if (size) term.resize(size.cols, Math.min(size.rows, 60));
      }
      term.write(data, () => term.scrollToBottom());
    });
    return () => {
      detach();
      term.dispose();
      termRef.current = null;
    };
    // theme changes are applied below without reattaching
  }, [consoleId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  return (
    <div className="aa-scroll min-h-0 flex-1 overflow-auto bg-canvas" data-testid="phone-terminal">
      <div ref={host} className="w-max p-1" />
    </div>
  );
}
