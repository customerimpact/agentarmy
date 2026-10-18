import { describe, expect, it } from 'vitest';
import { parseDialog, PromptDetector, stripAnsi } from './prompt-detector.js';

// Shaped like Claude Code 2.x Ink output: colors, ESC[1C instead of spaces, cursor moves, box lines
const BAR = '─'.repeat(40);
const PERMISSION_CHUNKS = [
  '\x1b[2K\x1b[1A\x1b[2K\x1b[G',
  `\x1b[38;2;177;185;249m╭${BAR}╮\x1b[39m\r\n`,
  '│ \x1b[1mBash\x1b[1Ccommand\x1b[22m\x1b[K\r\n│\r\n',
  '│   npm\x1b[1Ctest\r\n│   \x1b[2mRun the unit tests\x1b[22m\r\n│\r\n',
  '│ Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?\r\n',
  '│ \x1b[38;2;177;185;249m❯\x1b[1C1.\x1b[1CYes\x1b[39m\r\n',
  "│   2.\x1b[1CYes,\x1b[1Cand\x1b[1Cdon't\x1b[1Cask\x1b[1Cagain\x1b[1Cfor\x1b[1Cnpm\x1b[1Ctest\x1b[1Ccommands\r\n",
  '│   3. No, and tell Claude what to do differently \x1b[2m(esc)\x1b[22m\r\n',
  `╰${BAR}╯\r\n`,
];

const TRUST_CHUNKS = [
  '\x1b[?25l\x1b[2J\x1b[H\x1b]0;Claude Code\x07',
  '\x1b[38;2;215;119;87m Quick safety check\x1b[39m\r\n',
  ' Is this a project you created or one you trust?\x1b[1B\x1b[2G',
  '\x1b[38;2;177;185;249m❯\x1b[1C1.\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\x1b[39m',
  '\x1b[3;3H2. No, exit\r\n\x1b[2m Enter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel\x1b[22m',
];

const QUESTION_CHUNKS = [
  '● I have a couple of options here.\r\n',
  '\x1b[7m ☐ Approach \x1b[27m\r\n\r\n',
  'Which approach should I take for the cache?\r\n\r\n',
  '\x1b[36m❯ 1. In-memory LRU\x1b[39m\r\n',
  '     \x1b[2mFast, lost on restart\x1b[22m\r\n',
  '  2. Redis\r\n',
  '     \x1b[2mShared across instances\x1b[22m\r\n',
  '  3. Type something.\r\n\r\n',
  '\x1b[2mEnter to select · ↑/↓ to navigate · Esc to cancel\x1b[22m',
];

describe('parseDialog', () => {
  it('reads a permission dialog: question, three options, typed-answer option, context', () => {
    const dialog = parseDialog(stripAnsi(PERMISSION_CHUNKS.join('')));
    expect(dialog).toEqual({
      question: 'Do you want to proceed?',
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: "Yes, and don't ask again for npm test commands" },
        { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
      ],
      allowText: true,
      textKey: '3',
      context: ['Bash command', 'npm test', 'Run the unit tests'],
    });
  });

  it('reads the folder trust dialog', () => {
    const dialog = parseDialog(stripAnsi(TRUST_CHUNKS.join('')));
    expect(dialog?.question).toBe('Is this a project you created or one you trust?');
    expect(dialog?.options).toEqual([
      { key: '1', label: 'Yes, I trust this folder' },
      { key: '2', label: 'No, exit' },
    ]);
    expect(dialog?.allowText).toBe(false);
  });

  it('reads an AskUserQuestion list, skipping option descriptions', () => {
    const dialog = parseDialog(stripAnsi(QUESTION_CHUNKS.join('')));
    expect(dialog?.question).toBe('Which approach should I take for the cache?');
    expect(dialog?.options.map((o) => o.label)).toEqual(['In-memory LRU', 'Redis', 'Type something.']);
    expect(dialog?.textKey).toBe('3');
  });

  it('uses the newest copy when Ink redrew the dialog', () => {
    const old = stripAnsi(PERMISSION_CHUNKS.join('')).replace('npm test commands', 'old commands');
    const dialog = parseDialog(`${old}\n${stripAnsi(PERMISSION_CHUNKS.join(''))}`);
    expect(dialog?.options[1].label).toContain('npm test commands');
  });

  it('ignores numbered lists far above the bottom and ordinary output', () => {
    const reply = '● Plan:\n1. Read the code\n2. Fix it\n' + Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(parseDialog(reply)).toBeNull();
    expect(parseDialog('● Hey there!\n✻ Baked for 20s\n❯ ')).toBeNull();
    expect(parseDialog('1. only one option')).toBeNull();
  });

  it('is available from the PromptDetector tail and cleared by reset', () => {
    const detector = new PromptDetector();
    for (const chunk of PERMISSION_CHUNKS) detector.feed(chunk);
    expect(detector.dialog()?.options).toHaveLength(3);
    detector.reset();
    expect(detector.dialog()).toBeNull();
  });
});
