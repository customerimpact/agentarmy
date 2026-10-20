#!/usr/bin/env node
// Fake OpenAI Codex CLI for end-to-end tests. Understands what GridHive passes (`resume <id>|--last`,
// `-c key=value` overrides) and draws a small Codex-like TUI:
//   ask   -> "Would you like to run the following command?" with numbered Yes/No choices and, when
//            -c tui.notifications=true, an OSC 9 "Approval requested: ..." notification.
//            y / 1 / 2 approve, n / 3 / Esc deny (single keys), then the turn finishes
//   exit  -> exit 0
//   limit -> Codex's "You've hit your usage limit ... try again at 11:45 PM." error
//   anything else -> "• Working (Ns • esc to interrupt)" redrawn for FAKE_CODEX_DELAY_MS (default 1200),
//            then "Done: <prompt>", OSC 9 "Agent turn complete" and the -c notify program is run with
//            the agent-turn-complete JSON as its last argument, as Codex does.
// --version prints a version line. FAKE_CODEX_LOG=<file> appends argv as JSON (debugging).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const DELAY_MS = Number(process.env.FAKE_CODEX_DELAY_MS ?? 1200);
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(argv) + '\n');

// `codex login`: like the real one, the user finishes it in the terminal (here: press Enter), then
// auth.json is written into CODEX_HOME. Refuses without CODEX_HOME so it never touches a real ~/.codex.
if (argv[0] === 'login') {
  const home = process.env.CODEX_HOME;
  if (!home) {
    console.error('fake codex login: CODEX_HOME is not set');
    process.exit(1);
  }
  process.stdout.write(`Fake Codex login\r\ncodex-home ${home}\r\nPress Enter to finish signing in\r\n`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (d) => {
    if (!/[\r\n]/.test(String(d))) return;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(`${home}/auth.json`, JSON.stringify({ fake: true }));
    process.stdout.write('Successfully logged in\r\n');
    setTimeout(() => process.exit(0), 300);
  });
  await new Promise(() => {}); // the TUI below never starts
}

const config = {};
let resume = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-c' || argv[i] === '--config') {
    const pair = argv[++i] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) config[pair.slice(0, eq)] = pair.slice(eq + 1);
  } else if (argv[i] === 'resume') {
    resume = argv[i + 1] && !argv[i + 1].startsWith('-c') ? argv[++i] : '--last';
  }
}

// Just enough TOML for ['a','b'] / ["a","b"] arrays
function tomlArray(value) {
  if (!value) return null;
  return [...value.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] !== undefined ? m[1] : JSON.parse(`"${m[2]}"`)));
}

const notify = tomlArray(config.notify);
const osc9 = config['tui.notifications'] === 'true';
const threadId = resume && resume !== '--last' ? resume : crypto.randomUUID();
const out = (s) => process.stdout.write(s);
const notifyTerminal = (msg) => {
  if (osc9) out(`\x1b]9;${msg}\x07`);
};

out('\x1b[2J\x1b[H\x1b[1m>_ OpenAI Codex\x1b[0m (fake)\r\n');
out(`\x1b[2mthread ${threadId}\x1b[0m\r\n`);
if (process.env.CODEX_HOME) out(`\x1b[2mcodex-home ${process.env.CODEX_HOME}\x1b[0m\r\n`);
if (resume) out(`Resumed session ${resume}\r\n`);
if (config['mcp_servers.agentarmy.command']) out('\x1b[2mmcp: agentarmy ready\x1b[0m\r\n');
out('\r\n');

let line = '';
let busy = false;
let pendingApproval = null;

function prompt() {
  out('\x1b[36m›\x1b[0m ');
}

function finishTurn(text) {
  out(`\r\nDone: ${text}\r\n\r\n`);
  notifyTerminal('Agent turn complete');
  if (notify && notify.length) {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': threadId,
      'turn-id': crypto.randomUUID(),
      cwd: process.cwd(),
      'input-messages': [text],
      'last-assistant-message': `Done: ${text}`,
    });
    try {
      spawn(notify[0], [...notify.slice(1), payload], { stdio: 'ignore', windowsHide: true }).unref();
    } catch {
      // like Codex: a broken notify program never breaks the session
    }
  }
  busy = false;
  prompt();
}

function work(text, then) {
  busy = true;
  const started = Date.now();
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    out(`\r\x1b[2K\x1b[1m•\x1b[0m \x1b[1mWorking\x1b[0m \x1b[2m(${secs}s • esc to interrupt)\x1b[0m`);
  }, 200);
  setTimeout(() => {
    clearInterval(timer);
    out('\r\x1b[2K');
    then();
  }, DELAY_MS);
}

function ask(text) {
  busy = true;
  out('\r\n\x1b[1mWould you like to run the following command?\x1b[0m\r\n\r\n');
  out('  $ npm install left-pad\r\n\r\n');
  out('\x1b[36m› 1. Yes, proceed (y)\x1b[0m\r\n');
  out("  2. Yes, and don't ask again for this command (a)\r\n");
  out('  3. No, and tell Codex what to do differently (esc)\r\n\r\n');
  out('\x1b[2mPress enter to confirm or esc to cancel\x1b[0m\r\n');
  notifyTerminal('Approval requested: npm install left-pad');
  pendingApproval = text;
}

function submit(text) {
  out('\r\n');
  if (text === 'exit') process.exit(0);
  if (text === 'ask') return ask(text);
  if (text === 'limit') {
    // Codex's own wording (codex-cli 0.142 binary): usage limit hit, with a reset time
    out("\x1b[31m■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 11:45 PM.\x1b[0m\r\n\r\n");
    return prompt();
  }
  work(text, () => finishTurn(text.slice(0, 200)));
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let pasting = false; // bracketed paste (ESC[200~ ... ESC[201~): one prompt, newlines become spaces
let esc = '';
process.stdin.on('data', (data) => {
  for (const ch of data) {
    if (esc || (ch === '\x1b' && pendingApproval === null)) {
      esc += ch;
      if (esc === '\x1b[200~') (pasting = true), (esc = '');
      else if (esc === '\x1b[201~') (pasting = false), (esc = '');
      else if (!'\x1b[200~'.startsWith(esc) && !'\x1b[201~'.startsWith(esc)) esc = '';
      continue;
    }
    if (pasting && !busy) {
      line += ch === '\r' || ch === '\n' ? ' ' : ch;
      continue;
    }
    if (pendingApproval !== null) {
      const text = pendingApproval;
      if (ch === 'y' || ch === '1' || ch === '2' || ch === 'a' || ch === '\r') {
        pendingApproval = null;
        out('\r\n\x1b[32m✔ Approved\x1b[0m\r\n');
        work(text, () => finishTurn('ran npm install left-pad'));
      } else if (ch === 'n' || ch === '3' || ch === '\x1b') {
        pendingApproval = null;
        out('\r\n\x1b[31m✗ Denied\x1b[0m\r\n');
        finishTurn('denied');
      }
      continue;
    }
    if (ch === '\x03') process.exit(130);
    if (busy) continue;
    if (ch === '\r' || ch === '\n') {
      const text = line.replace(/\s+/g, ' ').trim();
      line = '';
      if (text) submit(text);
      else prompt();
    } else if (ch === '\x7f' || ch === '\b') {
      if (line) {
        line = line.slice(0, -1);
        out('\b \b');
      }
    } else if (ch >= ' ') {
      line += ch;
      out(ch);
    }
  }
});
prompt();
