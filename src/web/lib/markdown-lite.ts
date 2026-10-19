// Tiny markdown subset for sticky notes: headings, bold, italic, inline code, links, bullet /
// numbered / task lists and paragraphs. Produces a plain tree (rendered with React elements, never
// innerHTML), so note text can't inject markup.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: { c: Inline[]; task?: boolean; done?: boolean }[] }
  | { t: 'gap' };

export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return href;
  if (/^www\./i.test(href)) return `https://${href}`;
  return null;
}

const URL_RE = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    if (rest.startsWith('`')) {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'bold', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((rest[0] === '*' || rest[0] === '_') && rest[1] && rest[1] !== ' ' && rest[1] !== rest[0]) {
      const end = src.indexOf(rest[0], i + 1);
      // _snake_case_ words stay text: underscores only count at word boundaries
      const boundary = rest[0] === '*' || ((i === 0 || /\W/.test(src[i - 1])) && (end + 1 >= src.length || /\W/.test(src[end + 1])));
      if (end > i + 1 && src[end - 1] !== ' ' && boundary) {
        flush();
        out.push({ t: 'italic', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (rest[0] === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      const href = m ? safeHref(m[2]) : null;
      if (m && href) {
        flush();
        out.push({ t: 'link', href, c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    if ((rest[0] === 'h' || rest[0] === 'H') && (i === 0 || /\s|\(/.test(src[i - 1]))) {
      const m = URL_RE.exec(rest);
      if (m) {
        flush();
        out.push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] });
        i += m[1].length;
        continue;
      }
    }
    text += src[i];
    i++;
  }
  flush();
  return out;
}

export function parseMarkdownLite(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) blocks.push({ t: 'para', c: parseInline(para.join(' ')) });
    para = [];
  };
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      if (blocks.length && blocks[blocks.length - 1].t !== 'gap') blocks.push({ t: 'gap' });
      continue;
    }
    if (heading) {
      flushPara();
      blocks.push({ t: 'heading', level: heading[1].length as 1 | 2 | 3, c: parseInline(heading[2]) });
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      const ordered = !bullet;
      let body = (bullet ?? numbered)![1];
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(body);
      const entry: { c: Inline[]; task?: boolean; done?: boolean } = { c: [] };
      if (task) {
        entry.task = true;
        entry.done = task[1] !== ' ';
        body = task[2];
      }
      entry.c = parseInline(body);
      const last = blocks[blocks.length - 1];
      if (last?.t === 'list' && last.ordered === ordered) last.items.push(entry);
      else blocks.push({ t: 'list', ordered, items: [entry] });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  while (blocks.length && blocks[blocks.length - 1].t === 'gap') blocks.pop();
  return blocks;
}
