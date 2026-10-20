#!/usr/bin/env node
// Fake xAI Grok Build CLI (`grok`) for tests. Understands what AgentArmy passes (`--continue`,
// `-m <model>`) and draws a tiny TUI:
//   limit -> prints a rate-limit error (for the cross-provider fallback heuristics)
//   exit  -> exit 0
//   anything else -> "Thinking (Ns)" redrawn for FAKE_GROK_DELAY_MS (default 1200), then "Done: <prompt>"
// Bracketed pastes (ESC[200~ ... ESC[201~) arrive as one prompt. Prints which auth it would use
// (XAI_API_KEY last 4, or the browser login) but never the key. --version prints a version line.
// FAKE_GROK_LOG=<file> appends { argv, keyHint } as JSON.
import fs from 'node:fs';

const DELAY_MS = Number(process.env.FAKE_GROK_DELAY_MS ?? 1200);
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('grok 0.1.0-fake (Grok Build)');
  process.exit(0);
}
const key = process.env.XAI_API_KEY ?? '';
const keyHint = key ? key.slice(-4) : '';
if (process.env.FAKE_GROK_LOG) fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify({ argv, keyHint }) + '\n');

let model = 'grok-build';
for (let i = 0; i < argv.length; i++) if (argv[i] === '-m' || argv[i] === '--model') model = argv[++i] ?? model;
const out = (s) => process.stdout.write(s);

out('\x1b[2J\x1b[H\x1b[1mGrok Build\x1b[0m (fake)\r\n');
out(`\x1b[2mmodel ${model} · auth ${key ? `XAI_API_KEY ••••${keyHint}` : 'browser login'}\x1b[0m\r\n`);
if (argv.includes('--continue') || argv.includes('-c')) out('Continued the most recent session\r\n');
out('\r\n');

let line = '';
let busy = false;
let pasting = false;
let esc = '';

const prompt = () => out('\x1b[35m❯\x1b[0m ');

function submit(text) {
  out('\r\n');
  if (text === 'exit') process.exit(0);
  if (text === 'limit') {
    out('\x1b[31mError: 429 Too Many Requests: rate limit reached for grok-build. Try again in 1h.\x1b[0m\r\n\r\n');
    prompt();
    return;
  }
  busy = true;
  const started = Date.now();
  const timer = setInterval(() => out(`\r\x1b[2K\x1b[1mThinking\x1b[0m \x1b[2m(${Math.floor((Date.now() - started) / 1000)}s)\x1b[0m`), 200);
  setTimeout(() => {
    clearInterval(timer);
    out(`\r\x1b[2KDone: ${text.slice(0, 200)}\r\n\r\n`);
    busy = false;
    prompt();
  }, DELAY_MS);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  for (const ch of data) {
    if (esc || ch === '\x1b') {
      esc += ch;
      if (esc === '\x1b[200~') (pasting = true), (esc = '');
      else if (esc === '\x1b[201~') (pasting = false), (esc = '');
      else if (!'\x1b[200~'.startsWith(esc) && !'\x1b[201~'.startsWith(esc)) esc = ''; // other keys: ignored
      continue;
    }
    if (ch === '\x03') process.exit(130);
    if (busy) continue;
    if (pasting) {
      line += ch === '\r' || ch === '\n' ? ' ' : ch;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const text = line.replace(/\s+/g, ' ').trim();
      line = '';
      if (text) submit(text);
      else prompt();
    } else if (ch === '\x7f' || ch === '\b') {
      if (line) (line = line.slice(0, -1)), out('\b \b');
    } else if (ch >= ' ') {
      line += ch;
      out(ch);
    }
  }
});
prompt();
