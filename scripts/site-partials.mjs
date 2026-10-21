// Copies the header nav and the footer from site/index.html into the other English pages, so the
// menu is written once. Pages opt in with an (empty or stale) <header class="nav" id="top"> and
// <footer class="footer">. Translated homepages (site/<lang>/index.html) keep their own, but every
// homepage gets the same hreflang list so search engines link the languages together.
import fs from 'node:fs';
import path from 'node:path';

const site = path.resolve(import.meta.dirname, '../site');
const PAGES = ['quickstart.html', 'developers.html', 'app.html'];
const NAV = /<header class="nav" id="top">[\s\S]*?<\/header>/;
const FOOTER = /<footer class="footer">[\s\S]*?<\/footer>/;

const home = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const nav = home.match(NAV)?.[0];
const footer = home.match(FOOTER)?.[0];
if (!nav || !footer) throw new Error('index.html has no nav or footer');

for (const page of PAGES) {
  const file = path.join(site, page);
  const before = fs.readFileSync(file, 'utf8');
  if (!NAV.test(before) || !FOOTER.test(before)) throw new Error(`${page} has no nav or footer placeholder`);
  const after = before.replace(NAV, () => nav).replace(FOOTER, () => footer);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`synced nav and footer into ${page}`);
  }
}

const LANGS = { en: '', 'zh-Hans': 'zh', ja: 'ja', es: 'es', de: 'de', fr: 'fr', nl: 'nl' };
const ALTERNATES = /\n  <!-- hreflang -->[\s\S]*?<!-- \/hreflang -->/;
const alternates = [
  '\n  <!-- hreflang -->',
  ...Object.entries(LANGS).map(([lang, dir]) => `  <link rel="alternate" hreflang="${lang}" href="https://gridhive.dev/${dir}">`),
  '  <link rel="alternate" hreflang="x-default" href="https://gridhive.dev/">',
  '  <!-- /hreflang -->',
].join('\n');

for (const dir of Object.values(LANGS)) {
  const file = path.join(site, dir, 'index.html');
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = ALTERNATES.test(before)
    ? before.replace(ALTERNATES, () => alternates)
    : before.replace(/\n  <link rel="canonical"[^>]*>/, (m) => m + alternates);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`hreflang list in ${dir || 'en'}/index.html`);
  }
}
