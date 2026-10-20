import { describe, expect, it } from 'vitest';
import { commonBinDirs, mergePath, parseShellPath } from './shell-path';

describe('shell PATH for apps started from the Finder', () => {
  it('reads the PATH between the markers and ignores rc-file noise', () => {
    expect(parseShellPath('Welcome!\n__AGENTARMY_PATH__/opt/homebrew/bin:/usr/bin__AGENTARMY_PATH__')).toBe('/opt/homebrew/bin:/usr/bin');
    expect(parseShellPath('no markers here')).toBeNull();
    expect(parseShellPath('__AGENTARMY_PATH____AGENTARMY_PATH__')).toBeNull();
  });

  it('merges lists in order without duplicates or empty entries', () => {
    expect(mergePath('/a:/b', '/usr/bin:/b:', null, '/c::/a')).toBe('/a:/b:/usr/bin:/c');
  });

  it('adds the usual install folders for claude, Homebrew and npm', () => {
    const dirs = commonBinDirs('/Users/me');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/Users/me/.local/bin');
    expect(dirs).toContain('/Users/me/.claude/local');
  });
});
