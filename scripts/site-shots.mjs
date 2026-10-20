#!/usr/bin/env node
// Screenshots for the website (site/assets/shots/*.webp and site/assets/og.png).
// npm run site:shots (builds first)
//
// Starts the built server on a free port with a throwaway data folder and the demo Claude CLI
// (scripts/site-shots/demo-claude.mjs, no real agents, no network), stages an "Acme Shop" board
// through the API, photographs it with Playwright at 1600x1000 (device scale 1.5) and encodes
// WebP in Chromium (800/1600 wide, the hero also 2400). Never touches ~/.agentarmy or port 4317.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'site', 'assets', 'shots');
const OG = path.join(ROOT, 'site', 'assets', 'og.png');
const DEMO_DIR = path.join(ROOT, 'scripts', 'site-shots');
const SHIM = path.join(DEMO_DIR, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const VIEW = { width: 1600, height: 1000 };
const VIEW_W = VIEW.width;
const VIEW_H = VIEW.height;
const SCALE = 1.5;
// App theme for the main shots, closest to the site's night palette; the others get one shot each
const BASE_THEME = 'midnight';
const OTHER_THEMES = ['ember', 'aurora', 'paper'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, what, timeout = 30_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

// ---------- server ----------

async function startServer(home) {
  const port = await freePort();
  if (port === 4317 || port === 4318) throw new Error(`Refusing to use port ${port} (the live board or its phone access)`);
  // Only node and the OS on PATH: no real claude/codex/gemini can be detected or started
  const env = {
    ...process.env,
    PATH: [path.dirname(process.execPath), ...(process.platform === 'win32' ? ['C:\\Windows\\System32', 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(path.delimiter),
    AGENTARMY_HOME: path.join(home, '.agentarmy'),
    AGENTARMY_CLAUDE_PATH: SHIM,
    AGENTARMY_DISABLE_UPDATES: '1',
    AGENTARMY_BROWSER_PATH: chromium.executablePath(), // Playwright's Chromium for browser tiles, not the system Chrome
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    DEMO_CWD_LABEL: process.platform === 'win32' ? 'C:\\acme-shop' : '~/acme-shop',
  };
  delete env.CLAUDECODE;
  delete env.AGENTARMY_TOKEN;
  const proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), '--no-open', '--port', String(port)], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const url = await waitFor(async () => /is running: (http:\/\/\S+)/.exec(output)?.[1], `the server (${output})`);
  const token = new URL(url).searchParams.get('token');
  const api = async (method, urlPath, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}${urlPath.includes("?") ? "&" : "?"}token=${token}`, {
      method,
      headers: { 'x-agentarmy-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${await res.text()}`);
    return res.json();
  };
  const stop = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGTERM');
  };
  return { url, api, stop };
}

// ---------- staging ----------

// Claude Code keeps the login's e-mail and plan in <config dir>/.claude.json (~/.claude.json for the default)
function writeClaudeAccount(dir, email, organizationType) {
  const file = path.join(dir, '.claude.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email, organizationType } }));
}

async function stage(home, api) {
  // Three Claude accounts (Settings > Agents & accounts)
  writeClaudeAccount(home, 'sam@acme.test', 'claude_max');
  const accounts = await api('GET', '/api/accounts');
  const list = accounts.accounts ?? accounts;
  const personal = list.find((a) => a.id === 'default');
  if (personal) await api('PATCH', `/api/accounts/${personal.id}`, { name: 'Personal' });
  for (const [name, email] of [
    ['Work', 'sam.work@acme.test'],
    ['Side projects', 'sam.side@acme.test'],
  ]) {
    const account = await api('POST', '/api/accounts', { name, provider: 'claude' });
    writeClaudeAccount(account.configDir, email, 'claude_pro');
  }

  // Dev HQ: Ada the orchestrator + Frontend, Backend, Reviewers (4 each)
  const repo = path.join(home, 'acme-shop');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"acme-shop","private":true}\n');
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export {};\n');
  await api('POST', '/api/templates/dev-hq/launch', { cwd: repo, projectName: 'Acme Shop', origin: { x: 0, y: 0 } });

  const consoles = async () => (await api('GET', '/api/state')).consoles;
  const byName = async () => Object.fromEntries((await consoles()).map((c) => [c.name, c]));
  // Role prompts run one short turn each; wait until everyone rests
  await waitFor(async () => {
    const all = await consoles();
    return all.length >= 13 && all.every((c) => c.status === 'resting') && all;
  }, 'all 13 agents to finish their role prompt', 90_000);

  const c = await byName();
  const ada = c.Ada.id;
  const jobs = [
    ['Bex', 'Build checkout page', 'Build the checkout page with an order summary and a pay button.'],
    ['Cy', 'Add product filters', 'Add size, color and price filters to the product list.'],
    ['Fay', 'Orders API endpoint', 'Add POST /api/orders that validates the cart, reserves stock and returns the order id. Add tests.'],
    ['Gus', 'Stripe webhook handler', 'Handle the payment_intent.succeeded webhook and mark the order as paid.'],
    ['Ivy', 'Email receipts', 'Send an HTML receipt email when an order is paid. Reuse the order template.'],
    ['Jo', 'Review cart logic', 'Review src/cart.ts for rounding errors in totals and discounts.'],
    ['Kai', 'Review orders API', 'Review the orders API for race conditions when two carts reserve the last item.'],
  ];
  for (const [to, title, message] of jobs) {
    await api('POST', `/bridge/${ada}/jobs`, { to, title, message });
  }
  await api('POST', `/api/consoles/${c.Dax.id}/send`, { text: 'plan' });
  await api('POST', `/api/consoles/${c.Eli.id}/send`, { text: 'serve' });
  await api('POST', `/api/consoles/${c.Hal.id}/send`, { text: 'ask' });
  await waitFor(async () => (await byName()).Hal.status === 'needs_you', 'Hal to need you');
  await sleep(2500);
  return c;
}

// ---------- shooting ----------

async function encode(browser, png, outBase, widths) {
  const page = await browser.newPage();
  const data = `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`;
  for (const width of widths) {
    const webp = await page.evaluate(
      async ({ data, width }) => {
        const img = new Image();
        img.src = data;
        await img.decode();
        const height = Math.round((img.height * width) / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL('image/webp', 0.86);
      },
      { data, width },
    );
    fs.writeFileSync(`${outBase}-${width}.webp`, Buffer.from(webp.split(',')[1], 'base64'));
  }
  await page.close();
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gridhive-shots-'));
  const home = path.join(work, 'home');
  const raw = path.join(work, 'raw');
  fs.mkdirSync(home);
  fs.mkdirSync(raw);
  const server = await startServer(home);
  const browser = await chromium.launch();
  try {
    await stage(home, server.api);
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE });
    // Runs in the page: the theme comes in as an argument (Node variables are not visible there)
    await context.addInitScript((theme) => {
      try {
        if (!sessionStorage.getItem('shots-init')) {
          sessionStorage.setItem('shots-init', '1');
          localStorage.setItem('agentarmy.theme', theme);
        }
      } catch {}
    }, BASE_THEME);
    const page = await context.newPage();
    await page.goto(server.url);
    await page.getByTestId('sidebar-tab-agents').waitFor();
    await sleep(2500);
    const dismiss = async () => {
      // Preview offers are not part of the photos (the inbox has its own "No" buttons: leave those)
      const no = page.getByTestId('preview-offer-no');
      if (await no.count()) await no.first().click().catch(() => undefined);
    };
    const shot = async (name) => {
      await dismiss();
      await sleep(900);
      const file = path.join(raw, `${name}.png`);
      await page.screenshot({ path: file });
      return file;
    };
    const fitAll = async () => {
      await page.getByTestId('command-bar').getByRole('button', { name: 'Fit all' }).click();
      await sleep(1200);
    };
    const flyTo = async (name, zoomOut = 0) => {
      await page.getByTestId('sidebar-tab-agents').click();
      await page.locator('aside').getByText(name, { exact: true }).first().click();
      await sleep(1200);
      for (let i = 0; i < zoomOut; i++) {
        await page.getByRole('button', { name: /zoom out/i }).first().click();
        await sleep(250);
      }
      await sleep(800);
    };
    // Drags the empty board by (dx, dy), starting from a point where the pane (not a node) is hit
    const panBy = async (dx, dy) => {
      const start = await page.evaluate(
        ({ dx, dy, w, h }) => {
          for (let y = 80; y < h - 80; y += 20) {
            for (let x = 340; x < w - 40; x += 20) {
              const ex = x + dx;
              const ey = y + dy;
              if (ex < 330 || ey < 10 || ex > w - 10 || ey > h - 10) continue;
              if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
            }
          }
          return null;
        },
        { dx, dy, w: VIEW_W, h: VIEW_H },
      );
      if (!start) throw new Error(`No empty board to drag by ${dx},${dy}`);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 8 });
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
      await page.mouse.up();
      await sleep(700);
    };
    // Pans (in steps, re-measuring) until the element's center sits at (x, y)
    const centerOn = async (locator, x, y) => {
      for (let i = 0; i < 8; i++) {
        const box = await locator.boundingBox();
        const dx = x - (box.x + box.width / 2);
        const dy = y - (box.y + box.height / 2);
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        await panBy(Math.max(-500, Math.min(500, dx)), Math.max(-400, Math.min(400, dy)));
      }
    };
    const browserTile = page.locator('.react-flow__node-browser').first();
    const flyToBrowser = async (zoomOut = 0) => {
      await flyTo('Eli', zoomOut);
      await centerOn(browserTile, 960, zoomOut ? 680 : 620);
      // The headless browser starts and streams its first frames (a cold start can time out once)
      for (let i = 0; i < 30; i++) {
        if (!(await browserTile.getByText(/Could not start|Starting browser|Zoom in to load/).count())) break;
        if (i === 10) await browserTile.getByRole('button', { name: /reload/i }).first().click().catch(() => undefined);
        await sleep(1000);
      }
      await sleep(1500);
    };

    await page.getByTestId('preview-offer-yes').click({ timeout: 5000 }).catch(() => undefined); // only when auto previews are off
    await sleep(2000);

    const files = {};
    // Preview first: zooming in loads the page; the tile keeps that frame for the zoomed-out shots
    await flyToBrowser(); // warm-up; the tile keeps its last frame for the zoomed-out shots

    await flyTo('Ada', 1);
    await panBy(0, -200);
    files.hero = await shot('hero');
    await fitAll();
    files.board = await shot('board');

    await page.getByTestId('sidebar-tab-actions').click();
    files.actions = await shot('actions');
    await page.getByTestId('sidebar-tab-progress').click();
    files.progress = await shot('progress');
    await page.getByTestId('sidebar-tab-agents').click();

    await page.getByTestId('command-bar-mission-map').click();
    await page.getByTestId('mission-map').waitFor();
    files.map = await shot('map');
    await page.keyboard.press('Escape');
    await sleep(500);

    await page.keyboard.press('Control+Comma');
    await page.getByTestId('settings-window').waitFor();
    await page.getByTestId('settings-nav-agents').click();
    await waitFor(async () => !(await page.getByText('Checking agent CLIs').count()), 'the CLI check', 30_000);
    // Scroll the settings page so the Claude account cards fill the window
    const firstCard = page.getByTestId('account-card').first();
    await firstCard.waitFor();
    await firstCard.evaluate((el) => {
      let box = el.parentElement;
      while (box && getComputedStyle(box).overflowY !== 'auto' && getComputedStyle(box).overflowY !== 'scroll') box = box.parentElement;
      if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 55; // hides the CLI path line above the cards
    });
    files.accounts = await shot('accounts');
    await page.getByTestId('settings-nav-integrations').click();
    files.integrations = await shot('integrations');
    await page.keyboard.press('Escape');
    await sleep(500);

    await flyToBrowser(1);
    files.preview = await shot('preview');

    for (const theme of OTHER_THEMES) {
      await page.evaluate((t) => localStorage.setItem('agentarmy.theme', t), theme);
      await page.reload();
      await page.getByTestId('sidebar-tab-agents').waitFor();
      await sleep(2500);
      await fitAll();
      await flyToBrowser();
      await fitAll();
      files[`theme-${theme}`] = await shot(`theme-${theme}`);
    }
    await context.close();

    for (const [name, file] of Object.entries(files)) {
      await encode(browser, file, path.join(SHOTS, name), name === 'hero' ? [800, 1600, 2400] : [800, 1600]);
    }
    await renderOg(browser, path.join(SHOTS, 'hero-1600.webp'));
    console.log(`Shots written to ${SHOTS} (raw PNGs in ${raw})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

// npm run site:shots -- --og-only: redraw og.png from the current hero shot
async function ogOnly() {
  const browser = await chromium.launch();
  try {
    await renderOg(browser, path.join(SHOTS, 'hero-1600.webp'));
  } finally {
    await browser.close();
  }
}

// ---------- og.png (1200x630) ----------

async function renderOg(browser, heroWebp) {
  const icon = fs.readFileSync(path.join(ROOT, 'site', 'assets', 'icon.svg'), 'utf8');
  const hero = `data:image/webp;base64,${fs.readFileSync(heroWebp).toString('base64')}`;
  const html = `<!doctype html><meta charset="utf-8">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap"><style>
  *{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}
  body{font-family:Geist,"Segoe UI",system-ui,sans-serif;color:#f3f1ff;background:#08061a;position:relative}
  body::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);background-size:88px 88px;
    -webkit-mask-image:radial-gradient(ellipse 80% 80% at 30% 30%,#000 30%,transparent 85%)}
  .aurora{position:absolute;left:-10%;right:-10%;bottom:-200px;height:460px;filter:blur(70px);opacity:.85;
    background:radial-gradient(40% 55% at 22% 60%,rgba(105,81,224,.85),transparent 70%),radial-gradient(35% 50% at 52% 70%,rgba(143,211,255,.5),transparent 70%),radial-gradient(30% 45% at 80% 55%,rgba(244,166,215,.5),transparent 70%)}
  .brand{position:absolute;left:64px;top:64px;display:flex;align-items:center;gap:18px;font-size:28px;font-weight:600;letter-spacing:-.02em}
  .brand svg{width:52px;height:52px;border-radius:12px}
  h1{position:absolute;left:64px;top:150px;margin:0;font-size:66px;line-height:1.02;letter-spacing:-.045em;font-weight:500;width:560px}
  .hl{background:linear-gradient(95deg,#f4a6d7,#9d8cff 50%,#8fd3ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  p{position:absolute;left:64px;top:450px;margin:0;font-size:21px;line-height:1.45;color:#b9b4dc;width:520px}
  .chips{position:absolute;left:64px;top:532px;display:flex;gap:12px}
  .chip{font:500 16px Geist,system-ui,sans-serif;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);border-radius:999px;padding:8px 16px;color:#f3f1ff}
  .shot{position:absolute;left:640px;top:70px;width:720px;height:620px;border-radius:14px;overflow:hidden;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 80px rgba(0,0,0,.6),0 40px 120px -30px rgba(105,81,224,.7)}
  .shot img{width:960px;display:block}
  </style>
  <div class="aurora"></div>
  <div class="brand">${icon}<span>GridHive</span></div>
  <h1>Run a team of <span class="hl">Claude Code</span> agents from one board.</h1>
  <p>Real terminals, orchestrators that hand out jobs, one inbox for every prompt.</p>
  <div class="chips"><span class="chip">Free · MIT</span><span class="chip">No API keys</span><span class="chip">Runs locally</span></div>
  <div class="shot"><img src="${hero}"></div>`;
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: OG });
  await page.close();
}

(process.argv.includes('--og-only') ? ogOnly() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
