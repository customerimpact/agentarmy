import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdownLite, safeHref } from './markdown-lite';

describe('markdown-lite', () => {
  it('parses headings, paragraphs and lists', () => {
    const blocks = parseMarkdownLite('# Plan\nfirst line\nsame para\n\n- one\n- [x] two\n1. a\n2. b');
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'para', 'gap', 'list', 'list']);
    const list = blocks[3] as Extract<(typeof blocks)[number], { t: 'list' }>;
    expect(list.ordered).toBe(false);
    expect(list.items[1]).toMatchObject({ task: true, done: true });
    expect((blocks[4] as { ordered: boolean }).ordered).toBe(true);
  });

  it('parses bold, italic, code and links', () => {
    expect(parseInline('a **b** *c* `d`')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'bold', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'italic', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'd' },
    ]);
    expect(parseInline('[site](https://x.dev) and https://y.dev/a.')).toEqual([
      { t: 'link', href: 'https://x.dev', c: [{ t: 'text', v: 'site' }] },
      { t: 'text', v: ' and ' },
      { t: 'link', href: 'https://y.dev/a', c: [{ t: 'text', v: 'https://y.dev/a' }] },
      { t: 'text', v: '.' },
    ]);
  });

  it('never links javascript: urls and keeps snake_case words', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(parseInline('[x](javascript:alert(1))')[0]).toMatchObject({ t: 'text' });
    expect(parseInline('my_var_name')).toEqual([{ t: 'text', v: 'my_var_name' }]);
  });
});
