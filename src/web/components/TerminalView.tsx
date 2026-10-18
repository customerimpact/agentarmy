import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { socket } from '../lib/socket';
import { useBoard } from '../lib/store';
import { registerTerminal, unregisterTerminal } from '../lib/terminals';
import { getPrefs, usePrefs } from '../lib/prefs';
import { getTheme, subscribeTheme, terminalTheme } from '../lib/theme';

const TERMINAL_FONT =
  "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace";

const IS_WINDOWS = /win/i.test(navigator.platform);

// Combos the board owns even while a terminal has focus (see useShortcuts)
function isBoardShortcut(e: KeyboardEvent): boolean {
  return (
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    (e.code === 'BracketLeft' || e.code === 'BracketRight' || e.code === 'KeyJ')
  );
}

interface TerminalViewProps {
  id: string;
  hidden: boolean;
  webgl: boolean;
}

export function TerminalView({ id, hidden, webgl }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(force?: boolean) => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current!;
    const prefs = getPrefs();
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: prefs.termFontSize,
      lineHeight: prefs.termLineHeight,
      cursorBlink: prefs.termCursorBlink,
      scrollback: prefs.termScrollback,
      theme: terminalTheme(getTheme()),
      allowProposedApi: true,
      windowsPty: IS_WINDOWS ? { backend: 'conpty' } : undefined,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    registerTerminal(id, term);

    let lastSent = { cols: 0, rows: 0 };
    let resizeTimer: number | undefined;
    const sendSize = (force = false) => {
      if (!force && term.cols === lastSent.cols && term.rows === lastSent.rows) return;
      lastSent = { cols: term.cols, rows: term.rows };
      socket.send({ type: 'resize', id, cols: term.cols, rows: term.rows });
    };
    const fitNow = (force = false) => {
      // A display:none host (status card mode) measures 0x0; fitting then would collapse the PTY
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => sendSize(force), 80);
    };
    fitRef.current = fitNow;
    fitNow();

    const unsubscribe = socket.subscribe(id, (kind, data) => {
      if (kind === 'replay') {
        term.reset();
        term.write(data);
        // A (re)attach may be to a fresh PTY that doesn't know our size yet
        if (host.clientWidth) sendSize(true);
      } else {
        term.write(data);
      }
    });

    const dataSub = term.onData((data) => socket.send({ type: 'input', id, data }));

    term.attachCustomKeyEventHandler((e) => {
      if (isBoardShortcut(e)) return false;
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+C copies when there is a selection (like Windows Terminal), otherwise it's SIGINT
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyC' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
        term.clearSelection();
        return false;
      }
      // Let the browser fire a native paste event (xterm handles it) instead of sending ^V
      if (mod && !e.altKey && e.code === 'KeyV') return false;
      return true;
    });

    // Ctrl/cmd+wheel zooms the board (handled by the node); plain wheel scrolls the terminal
    term.attachCustomWheelEventHandler((e) => !(e.ctrlKey || e.metaKey));

    // Follow the app color theme live
    const unsubscribeTheme = subscribeTheme(() => {
      term.options.theme = terminalTheme(getTheme());
    });

    // Settings > Terminals apply live; a new font size changes cols/rows, so refit
    const unsubscribePrefs = usePrefs.subscribe((state, prev) => {
      const p = state.prefs;
      const q = prev.prefs;
      if (p.termCursorBlink !== q.termCursorBlink) term.options.cursorBlink = p.termCursorBlink;
      if (p.termScrollback !== q.termScrollback) term.options.scrollback = p.termScrollback;
      if (p.termFontSize !== q.termFontSize || p.termLineHeight !== q.termLineHeight) {
        term.options.fontSize = p.termFontSize;
        term.options.lineHeight = p.termLineHeight;
        fitNow();
      }
    });

    const onFocus = () => useBoard.getState().select(id);
    term.textarea?.addEventListener('focus', onFocus);

    let observerTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(observerTimer);
      observerTimer = window.setTimeout(() => fitNow(), 40);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      window.clearTimeout(observerTimer);
      window.clearTimeout(resizeTimer);
      term.textarea?.removeEventListener('focus', onFocus);
      dataSub.dispose();
      unsubscribe();
      unsubscribeTheme();
      unsubscribePrefs();
      unregisterTerminal(id, term);
      termRef.current = null;
      term.dispose();
    };
  }, [id]);

  // WebGL only for the focused console: Chromium caps live WebGL contexts at ~16 per page
  useEffect(() => {
    const term = termRef.current;
    if (!term || !webgl || hidden) return;
    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon?.dispose();
        addon = null;
      });
      term.loadAddon(addon);
    } catch {
      addon = null; // DOM renderer stays in charge
    }
    return () => {
      try {
        addon?.dispose();
      } catch {
        // already disposed after a context loss
      }
    };
  }, [webgl, hidden]);

  useEffect(() => {
    if (!hidden) fitRef.current();
  }, [hidden]);

  return (
    <div
      ref={hostRef}
      data-testid="console-terminal"
      className="aa-term-host absolute inset-0 bg-term"
      style={{ display: hidden ? 'none' : 'block' }}
    />
  );
}
