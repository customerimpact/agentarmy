import { describe, expect, it } from 'vitest';
import { CONSOLE_NAMES, pickConsoleName } from './console-names.js';

describe('pickConsoleName', () => {
  it('starts at the top of the list', () => {
    expect(pickConsoleName([])).toBe('Ada');
  });

  it('skips names already in use, case-insensitively', () => {
    expect(pickConsoleName(['ada', 'Bex ', 'Dax'])).toBe('Cy');
  });

  it('appends 2, 3, ... once every name is taken', () => {
    expect(pickConsoleName(CONSOLE_NAMES)).toBe('Ada 2');
    expect(pickConsoleName([...CONSOLE_NAMES, 'Ada 2'])).toBe('Bex 2');
    const twoRounds = [...CONSOLE_NAMES, ...CONSOLE_NAMES.map((n) => `${n} 2`)];
    expect(pickConsoleName(twoRounds)).toBe('Ada 3');
  });
});
