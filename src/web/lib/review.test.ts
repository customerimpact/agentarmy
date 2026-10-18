import { describe, expect, it } from 'vitest';
import type { Job } from '../../shared/protocol';
import { defaultCommitMessage, parseUnifiedDiff } from './review';

describe('parseUnifiedDiff', () => {
  it('numbers old and new lines and drops file headers', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const rows = parseUnifiedDiff(diff);
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
      ['hunk', null, null, '@@ -1,3 +1,3 @@'],
      ['ctx', 1, 1, 'one'],
      ['del', 2, null, 'two'],
      ['add', null, 2, 'TWO'],
      ['ctx', 3, 3, 'three'],
      ['meta', null, null, '\\ No newline at end of file'],
    ]);
  });
});

describe('defaultCommitMessage', () => {
  const job = (toId: string, title: string, updatedAt: number) =>
    ({ id: title, fromId: null, toId, title, message: '', status: 'done', createdAt: 0, updatedAt }) as Job;

  it('prefers the last job title, then the activity', () => {
    const c = { id: 'c1', name: 'Ada', activity: 'Edit src/app.ts' };
    expect(defaultCommitMessage(c, [job('c1', 'Old', 1), job('c1', 'Add login', 2), job('c2', 'X', 3)])).toBe(
      'Ada: Add login',
    );
    expect(defaultCommitMessage(c, [])).toBe('Ada: Edit src/app.ts');
    expect(defaultCommitMessage({ id: 'c1', name: 'Ada' }, [])).toBe('Ada: work in progress');
  });
});
