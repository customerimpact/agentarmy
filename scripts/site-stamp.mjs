// Adds ?v=<content hash> to the site's CSS and JS links so browsers never mix a new page with an
// old cached stylesheet (styles.css and main.js are cached for an hour). Run before deploying the site.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const site = path.resolve(import.meta.dirname, '../site');
const assets = ['styles.css', 'main.js', 'hero-demo.js', 'r.js', 'account.js', 'link.js'];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(site, file))).digest('hex').slice(0, 10);

// Top-level pages plus the translated homepages in site/<lang>/
const pages = fs.readdirSync(site, { withFileTypes: true }).flatMap((entry) => {
  if (entry.isFile() && entry.name.endsWith('.html')) return [entry.name];
  const index = path.join(entry.name, 'index.html');
  return entry.isDirectory() && /^[a-z]{2}$/.test(entry.name) && fs.existsSync(path.join(site, index)) ? [index] : [];
});

for (const page of pages) {
  const file = path.join(site, page);
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const asset of assets) {
    if (!fs.existsSync(path.join(site, asset))) continue;
    const link = new RegExp('"/' + asset.replace('.', '[.]') + '(?:[?]v=[0-9a-f]+)?"', 'g');
    after = after.replace(link, `"/${asset}?v=${hash(asset)}"`);
  }
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`stamped ${page}`);
  }
}
