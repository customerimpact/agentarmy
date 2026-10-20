#!/usr/bin/env node
// Demo Claude Code CLI for the website screenshots (npm run site:shots). A copy of
// tests/fake-claude/fake-claude.mjs whose turns print Claude-like output and, unlike the test fake,
// keep working until told otherwise, so the board can be staged and photographed:
//   "You are ..." (role prompts) -> reads, works, "Done. Changes are ready for review.", Stop
//   ask    -> permission dialog for `npm test -- checkout` (needs you)
//   serve  -> a Vite-style dev server serving a small shop page (auto preview tile)
//   plan   -> TodoWrite with three steps, then keeps working
//   finish -> "Done." and Stop
//   anything else (jobs) -> reads, "Working on it..." and stays working
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TURN_DELAY_MS = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 800);

function parseArgs(argv) {
  const args = { sessionId: null, resume: null, settings: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
      return argv[++i];
    };
    if (arg === '--session-id' || arg.startsWith('--session-id=')) args.sessionId = value();
    else if (arg === '--resume' || arg === '-r' || arg.startsWith('--resume=')) args.resume = value();
    else if (arg === '--settings' || arg.startsWith('--settings=')) args.settings = value();
    else args.rest.push(arg);
  }
  return args;
}

function loadHooks(settingsPath) {
  if (!settingsPath) return {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    // Real Claude Code also accepts inline JSON for --settings
    const settings = JSON.parse(raw.trim().startsWith('{') ? raw : '{}');
    return settings.hooks ?? {};
  } catch {
    try {
      return JSON.parse(settingsPath).hooks ?? {};
    } catch {
      return {};
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const hooks = loadHooks(args.settings);
const cwd = process.cwd();
const sessionId = args.resume ?? args.sessionId ?? crypto.randomUUID();
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const realTranscripts = process.env.FAKE_CLAUDE_REAL_TRANSCRIPTS === '1';
const transcriptPath = realTranscripts
  ? path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  : path.join(os.tmpdir(), 'fake-claude', `${sessionId}.jsonl`);

function appendTranscript(entry) {
  if (!realTranscripts) return;
  try {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ sessionId, timestamp: new Date().toISOString(), ...entry })}
`);
  } catch {
    // test aid only
  }
}

const out = (text) => process.stdout.write(text);
const line = (text = '') => out(`${text}\r\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logPayload(payload) {
  const file = process.env.FAKE_CLAUDE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
  } catch {
    // debugging aid only
  }
}

function runCommandHook(hook, body) {
  return new Promise((resolve) => {
    let child;
    try {
      child = Array.isArray(hook.args)
        ? spawn(hook.command, hook.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
        : spawn(hook.command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill(), (hook.timeout ?? 60) * 1000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(body);
  });
}

async function runHttpHook(hook, body) {
  try {
    await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout((hook.timeout ?? 30) * 1000),
    });
  } catch {
    // Claude Code ignores failing hooks too
  }
}

// Hooks run one after another so the server sees events in the order Claude Code sends them
let hookChain = Promise.resolve();

function fireHook(event, extra = {}) {
  const payload = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
  logPayload(payload);
  // Real transcripts also get the assistant side: tool calls and the final text (handoff briefs read them)
  if (event === 'PreToolUse' && extra.tool_name) {
    appendTranscript({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: extra.tool_name, input: extra.tool_input ?? {} }] } });
  } else if (event === 'Stop' && extra.last_assistant_message) {
    appendTranscript({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: extra.last_assistant_message }] } });
  }
  const body = JSON.stringify(payload);
  const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
  hookChain = hookChain.then(async () => {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        if (hook.type === 'http' && hook.url) await runHttpHook(hook, body);
        else if (hook.type === 'command' && hook.command) await runCommandHook(hook, body);
      }
    }
  });
  return hookChain;
}

// Same shape as a real Claude Code assistant transcript entry (content trimmed)
function writeUsageLine(output) {
  const id = `msg_fake_${crypto.randomUUID()}`;
  const entry = {
    parentUuid: null,
    isSidechain: false,
    message: {
      model: 'claude-sonnet-5-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'fake reply' }],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 10000,
        output_tokens: output,
        cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
      },
    },
    requestId: `req_${id}`,
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
  };
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  // Streaming writes the same message once per content block; write it twice like that
  const json = JSON.stringify(entry);
  fs.appendFileSync(transcriptPath, `${json}\n${json}\n`);
}

// ---------- terminal ----------

const PROMPT = '> ';
let buffer = '';
let busy = false;
let waitingForPermission = null; // resolve fn while "ask" waits for a y line

function showPrompt() {
  out(PROMPT);
}

async function exitWith(code) {
  await hookChain;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}

const ORANGE = (t) => `\x1b[38;2;232;119;74m${t}\x1b[39m`;
const DIM = (t) => `\x1b[2m${t}\x1b[22m`;
const bullet = (t) => line(`${ORANGE('●')} ${t}`);
const done = (t) => line(`\x1b[97m●\x1b[39m ${t}`);

async function readCodebase() {
  bullet('Reading the codebase…');
  await fireHook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/app.ts' } });
  line(DIM('  ⎿  Read src/app.ts, package.json'));
  await fireHook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/app.ts' } });
  await sleep(300);
}

async function runTurn(prompt) {
  busy = true;
  await fireHook('UserPromptSubmit', { prompt });

  if (prompt === 'ask') {
    await readCodebase();
    bullet('Working on it…');
    await fireHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test -- checkout' } });
    await fireHook('Notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    const bar = '─'.repeat(58);
    line(`\x1b[38;2;177;185;249m╭${bar}╮\x1b[39m`);
    line('│ \x1b[1mBash command\x1b[22m');
    line('│');
    line('│   npm test -- checkout');
    line(`│   ${DIM('Run the checkout tests')}`);
    line('│');
    line('│ Do you want to proceed?');
    line('│ \x1b[38;2;177;185;249m❯ 1. Yes\x1b[39m');
    line("│   2. Yes, and don't ask again for npm test commands in this folder");
    line(`│   3. No, and tell Claude what to do differently ${DIM('(esc)')}`);
    line(`\x1b[38;2;177;185;249m╰${bar}╯\x1b[39m`);
    busy = false;
    await new Promise((resolve) => {
      waitingForPermission = resolve;
    });
    busy = true;
    await fireHook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test -- checkout' } });
    done('Checkout tests pass.');
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: 'Checkout tests pass.' });
  } else if (prompt === 'serve') {
    await fireHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run dev' } });
    const port = await startDevServer();
    line();
    line('  \x1b[32m\x1b[1mVITE\x1b[22m v7.0.0\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m123\x1b[22m ms');
    line();
    line(`  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m${port}\x1b[22m/\x1b[39m`);
    line('  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m');
    await sleep(500);
    line(`Dev server is running at http://localhost:${port}/`);
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: `Dev server is running at http://localhost:${port}/` });
  } else if (prompt === 'plan') {
    const todos = [
      { content: 'Sketch the layout', status: 'completed', activeForm: 'Sketching the layout' },
      { content: 'Build the page', status: 'in_progress', activeForm: 'Building the page' },
      { content: 'Write the tests', status: 'pending', activeForm: 'Writing the tests' },
    ];
    await fireHook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } });
    await fireHook('PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos } });
    bullet('Updating tasks');
    line(DIM('  ⎿  ☒ Sketch the layout'));
    line(DIM('     ☐ Build the page'));
    line(DIM('     ☐ Write the tests'));
    return; // keeps working
  } else if (prompt === 'finish') {
    done('Done. Changes are ready for review.');
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: 'Done. Changes are ready for review.' });
  } else if (/^You are /.test(prompt)) {
    await readCodebase();
    bullet('Working on it…');
    await sleep(Number(process.env.DEMO_ROLE_MS ?? 1500));
    done('Done. Changes are ready for review.');
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: 'Ready.' });
  } else {
    await readCodebase();
    bullet('Working on it…');
    return; // a job: stays working for the photo
  }
  busy = false;
  showPrompt();
}

let devServer = null;

const SHOP_PAGE = `<!doctype html><meta charset=utf-8><title>Acme Shop</title>
<style>body{margin:0;font:15px/1.4 Inter,system-ui,sans-serif;background:#faf6f2;color:#1c1917}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 28px}
b{font-size:18px}nav{display:flex;gap:22px;align-items:center;font-size:14px}
.cart{background:#1c1917;color:#fff;border-radius:999px;padding:7px 14px}
main{padding:24px 28px}h1{font-size:34px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:#78716c;font-size:14px}.chips{display:flex;gap:8px;margin:18px 0}
.chip{border:1px solid #e7e5e4;border-radius:999px;padding:5px 13px;font-size:13px;background:#fff}
.chip.on{background:#1f5f4f;color:#fff;border-color:#1f5f4f}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px #0001}
.img{height:150px}.card p{margin:10px 12px 0;font-weight:500}.card span{display:block;margin:2px 12px 12px;color:#57534e}</style>
<header><b>acme.shop</b><nav><span>New</span><span>Men</span><span>Women</span><span class=cart>Cart (2)</span></nav></header>
<main><h1>Autumn essentials</h1><div class=sub>Free shipping over €50 · 30-day returns</div>
<div class=chips><span class='chip on'>All</span><span class=chip>Size</span><span class=chip>Color</span><span class=chip>Price</span></div>
<div class=grid>
<div class=card><div class=img style='background:linear-gradient(135deg,#f2c46d,#e8833f)'></div><p>Wool overshirt</p><span>€89</span></div>
<div class=card><div class=img style='background:linear-gradient(135deg,#2a9d8f,#1d4e5f)'></div><p>Rain shell</p><span>€129</span></div>
<div class=card><div class=img style='background:linear-gradient(135deg,#e76f51,#9c3d2e)'></div><p>Knit beanie</p><span>€24</span></div>
<div class=card><div class=img style='background:linear-gradient(135deg,#8fb98b,#3f6b45)'></div><p>Trail sneaker</p><span>€115</span></div>
</div></main>`;

// 'serve': one page on a free port, alive until this fake CLI exits
function startDevServer() {
  if (devServer) return Promise.resolve(devServer.address().port);
  return new Promise((resolve) => {
    devServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SHOP_PAGE);
    });
    devServer.listen(0, 'localhost', () => resolve(devServer.address().port));
  });
}

async function submit(text) {
  const prompt = text.trim();
  if (waitingForPermission) {
    const resolve = waitingForPermission;
    waitingForPermission = null;
    resolve(prompt.toLowerCase());
    return;
  }
  if (!prompt) {
    showPrompt();
    return;
  }
  if (prompt === 'exit') {
    line('Goodbye');
    await fireHook('SessionEnd', { reason: 'prompt_input_exit' });
    await exitWith(0);
    return;
  }
  if (prompt === '/login') {
    // Real Claude Code opens a browser OAuth flow; the fake just stores an account like a login does
    const file = process.env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // new file
    }
    config.oauthAccount = { emailAddress: `fake-${path.basename(configDir)}@example.com`, organizationType: 'claude_pro' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
    line('Login successful. Press Enter to continue');
    showPrompt();
    return;
  }
  if (prompt === 'crash') {
    line('Fake crash');
    await exitWith(3);
    return;
  }
  void runTurn(prompt);
}

// While the permission dialog is open, one key answers it (like Claude Code's number keys)
// Digits only: focus changes reach the PTY as a lone Esc, which must not dismiss the dialog in a photo
const DIALOG_KEYS = { 1: '1', 2: '2', 3: 'n' };

function onInput(chunk) {
  // Bracketed paste markers would otherwise end up in the prompt
  const text = chunk.replace(/\x1b\[20[01]~/g, '');
  if (waitingForPermission && !buffer && Object.hasOwn(DIALOG_KEYS, text)) {
    const resolve = waitingForPermission;
    waitingForPermission = null;
    line();
    resolve(DIALOG_KEYS[text]);
    return;
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\x03') {
      buffer = '';
      line('^C');
      if (!busy) showPrompt();
    } else if (ch === '\r' || ch === '\n') {
      // \r\n from a pasted line counts as one submit
      if (ch === '\r' && text[i + 1] === '\n') i++;
      const submitted = buffer;
      buffer = '';
      line();
      if (busy && !waitingForPermission) continue; // like Claude, ignore input mid-turn here
      void submit(submitted);
    } else if (ch === '\x7f' || ch === '\b') {
      if (buffer.length) {
        buffer = buffer.slice(0, -1);
        out('\b \b');
      }
    } else if (ch === '\x1b') {
      // Skip simple CSI sequences (arrow keys, focus events)
      const match = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      i += match ? match[0].length - 1 : 0;
    } else if (ch >= ' ') {
      buffer += ch;
      out(ch);
    }
  }
}

async function main() {
  // -p / --print: read the prompt from stdin and print a canned reply (smart handoff briefs)
  if (args.rest.includes('-p') || args.rest.includes('--print')) {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const facts = input.split(/\r?\n/).filter((l) => l.startsWith('- ')).length;
    process.stdout.write(['Goal: fake smart brief', `Done: ${facts} facts read`, `Args: ${args.rest.join(' ')}`, ''].join('\n'));
    process.exit(0);
  }
  if (args.resume && realTranscripts && !fs.existsSync(transcriptPath)) {
    line(`No conversation found with session ID: ${args.resume}`);
    process.exit(1);
  }
  if (args.resume && process.env.FAKE_CLAUDE_FAIL_RESUME === '1') {
    line(`No conversation found with session ID: ${args.resume}`);
    process.exit(1);
  }

  line(`${ORANGE('✻')} \x1b[1mClaude Code\x1b[22m`);
  line(DIM(process.env.DEMO_CWD_LABEL ?? cwd));
  line();

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onInput);
  process.stdin.on('end', () => void exitWith(0));
  process.stdin.resume();

  // Real Claude Code ignores SIGINT in its TUI and handles Ctrl-C itself
  process.on('SIGINT', () => {
    line('^C');
  });

  await fireHook('SessionStart', { source: args.resume ? 'resume' : 'startup', model: 'claude-sonnet-5-5' });
  showPrompt();
}

void main();
