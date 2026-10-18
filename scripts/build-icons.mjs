// Renders the desktop app icons from src/web/public/icon.svg into build/icons/:
//   icon.ico (16-256 px, every size rendered from the SVG, not downscaled), icon.png (512 px),
//   tray*.png and tray-attention*.png (16/20/24/32 px for 100-200 % display scaling).
// Dev dependencies: @resvg/resvg-js (SVG -> PNG, prebuilt binary, no system libs) and
// png-to-ico (packs the PNGs into one .ico). Run: npm run desktop:icons
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'icons');
const svg = fs.readFileSync(path.join(root, 'src', 'web', 'public', 'icon.svg'), 'utf8');

// "Someone needs you" variant: a bright amber dot in the top-right corner
const attentionSvg = svg.replace(
  '</svg>',
  '  <circle cx="50" cy="14" r="12" fill="#fbbf3c" stroke="#120e0c" stroke-width="4"/>\n</svg>',
);

function render(source, size) {
  return new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

fs.mkdirSync(outDir, { recursive: true });

const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const ico = await pngToIco(icoSizes.map((size) => render(svg, size)));
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), render(svg, 512));

// Electron picks name@<scale>x.png automatically for the display's scale factor
const trayScales = [
  ['', 16],
  ['@1.25x', 20],
  ['@1.5x', 24],
  ['@2x', 32],
];
for (const [suffix, size] of trayScales) {
  fs.writeFileSync(path.join(outDir, `tray${suffix}.png`), render(svg, size));
  fs.writeFileSync(path.join(outDir, `tray-attention${suffix}.png`), render(attentionSvg, size));
}

console.log(`Icons written to ${path.relative(root, outDir)}`);
