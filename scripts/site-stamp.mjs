// Adds ?v=<content hash> to the site's CSS and JS links so browsers never mix a new page with an
// old cached stylesheet (styles.css and main.js are cached for an hour). Run before deploying the site.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const site = path.resolve(import.meta.dirname, '../site');
const assets = ['styles.css', 'main.js', 'hero-demo.js', 'r.js', 'account.js'];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(site, file))).digest('hex').slice(0, 10);

for (const page of fs.readdirSync(site).filter((f) => f.endsWith('.html'))) {
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
