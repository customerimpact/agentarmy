import { describe, expect, it } from 'vitest';
import {
  detectPrompt,
  isDismissInput,
  PromptDetector,
  QUESTION_DETAIL,
  stripAnsi,
  TRUST_DETAIL,
} from './prompt-detector.js';

// Shaped like Claude Code's Ink output: colors, cursor-forward instead of spaces, line moves
const TRUST_CHUNKS = [
  '\x1b[?25l\x1b[2J\x1b[H\x1b]0;Claude Code\x07',
  '\x1b[38;2;215;119;87m Quick safety check\x1b[39m\r\n',
  ' Is this a project you created or one you trust?\x1b[1B\x1b[2G',
  '\x1b[38;2;177;185;249m❯\x1b[1C1.\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\x1b[39m',
  '\x1b[3;3H2. No, exit\r\n\x1b[2m Enter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel\x1b[22m',
];

const AUTO_MODE_CHUNKS = [
  '\x1b[2K\x1b[1A\x1b[2K\x1b[G',
  '\x1b[1mTeach auto mode about your environment?\x1b[22m\r\n',
  '\x1b[36m❯ 1. Yes\x1b[39m\r\n   2. Not now\r\n',
  '\x1b[2mEnter to',
  ' confirm · Esc to cancel\x1b[22m',
];

describe('stripAnsi', () => {
  it('removes colors and titles and turns cursor moves into whitespace', () => {
    expect(stripAnsi('\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b[1Cword')).toBe('red word');
    expect(stripAnsi('a\x1b[3;3Hb')).toBe('a\nb');
    expect(stripAnsi('\x1b[?25l\x1b[?2004hx\x1b7\x1b8')).toBe('x');
  });
});

describe('detectPrompt', () => {
  it('recognises the trust dialog before any generic question', () => {
    expect(detectPrompt(stripAnsi(TRUST_CHUNKS.join('')))).toBe(TRUST_DETAIL);
  });

  it('recognises other Enter-to-confirm menus', () => {
    expect(detectPrompt(stripAnsi(AUTO_MODE_CHUNKS.join('')))).toBe(QUESTION_DETAIL);
  });

  it('ignores ordinary output', () => {
    expect(detectPrompt('● Hey there!\n✻ Baked for 20s\n❯ ')).toBeNull();
  });
});

describe('PromptDetector', () => {
  it('matches text split across chunks and escape sequences', () => {
    const detector = new PromptDetector();
    for (const chunk of AUTO_MODE_CHUNKS) detector.feed(chunk);
    expect(detector.detect()).toBe(QUESTION_DETAIL);
  });

  it('forgets the old dialog after reset, so only a redraw re-detects it', () => {
    const detector = new PromptDetector();
    for (const chunk of TRUST_CHUNKS) detector.feed(chunk);
    detector.reset();
    detector.feed('\x1b[2J\x1b[H ▐▛███▜▌   Claude Code\r\n❯ ');
    expect(detector.detect()).toBeNull();
  });

  it('drops text that scrolled far out of the tail', () => {
    const detector = new PromptDetector();
    detector.feed('Enter to confirm');
    detector.feed('x'.repeat(5000));
    expect(detector.detect()).toBeNull();
  });
});

describe('isDismissInput', () => {
  it('treats Enter, a lone Esc and Ctrl-C as answers, arrows and typing as not', () => {
    expect(isDismissInput('\r')).toBe(true);
    expect(isDismissInput('\x1b')).toBe(true);
    expect(isDismissInput('\x03')).toBe(true);
    expect(isDismissInput('\x1b[B')).toBe(false);
    expect(isDismissInput('2')).toBe(false);
  });
});
