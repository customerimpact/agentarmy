import type { HLJSApi, LanguageFn } from 'highlight.js';

// Syntax highlighting for the code viewer and pinned file cards. highlight.js core (~8 KB gz) and
// each language grammar are separate lazy chunks, loaded the first time a file needs them, so the
// main bundle only carries this loader. Token colors come from our theme tokens (highlight.css).

type Loader = () => Promise<{ default: LanguageFn }>;

const LOADERS: Record<string, Loader> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  xml: () => import('highlight.js/lib/languages/xml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  php: () => import('highlight.js/lib/languages/php'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  swift: () => import('highlight.js/lib/languages/swift'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
};

// Large files stay plain text: highlighting 1 MB blocks the UI for a second or more
export const HIGHLIGHT_MAX_CHARS = 300_000;

let core: Promise<HLJSApi> | null = null;
const loaded = new Map<string, Promise<boolean>>();

function loadCore(): Promise<HLJSApi> {
  core ??= Promise.all([import('highlight.js/lib/core'), import('./highlight.css')]).then(([m]) => m.default);
  return core;
}

async function loadLanguage(hljs: HLJSApi, name: string): Promise<boolean> {
  const loader = LOADERS[name];
  if (!loader) return false;
  let p = loaded.get(name);
  if (!p) {
    p = loader()
      .then((m) => {
        hljs.registerLanguage(name, m.default);
        return true;
      })
      .catch(() => false);
    loaded.set(name, p);
  }
  return p;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// One HTML string per line. hljs spans can cross line breaks (block comments, template strings),
// so open spans are closed at each newline and reopened on the next line.
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1]);
      current += m[1];
    } else if (m[2]) {
      open.pop();
      current += m[2];
    } else if (m[3]) {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else current += m[4];
  }
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}

export function plainLines(text: string): string[] {
  return escapeHtml(text.replace(/\r\n?/g, '\n')).split('\n');
}

// Highlighted HTML lines (already escaped), or plain escaped lines when the language is unknown
export async function highlightLines(text: string, language: string | null): Promise<string[]> {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!language || !LOADERS[language] || normalized.length > HIGHLIGHT_MAX_CHARS) return plainLines(normalized);
  const hljs = await loadCore();
  if (!(await loadLanguage(hljs, language))) return plainLines(normalized);
  try {
    return splitHtmlLines(hljs.highlight(normalized, { language, ignoreIllegals: true }).value);
  } catch {
    return plainLines(normalized);
  }
}
