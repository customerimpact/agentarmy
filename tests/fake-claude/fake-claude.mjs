#!/usr/bin/env node
// Fake Claude Code CLI for deterministic end-to-end tests. It understands the flags AgentArmy
// passes (--session-id, --resume, --settings), fires the hooks from the settings file like
// Claude Code does, and offers a tiny line editor with a few magic prompts:
//   ask   -> Notification(permission_prompt) and a numbered permission dialog like Claude Code's;
//            "1"/"2"/"y" allow, "3"/"n"/Esc deny (single keys, no Enter needed), then Stop
//   fail  -> StopFailure
//   exit  -> SessionEnd, exit 0
//   crash -> exit 3
//   usage [n] -> like a normal turn, and appends an assistant usage line (n output tokens, default
//                1234; model claude-sonnet-5-5) to the transcript, as Claude Code does
//   serve -> starts a tiny HTTP server on a free port and prints a Vite-style
//            "  ➜  Local:   http://localhost:<port>/" line (auto dev previews)
//   plan  -> TodoWrite with one completed, one in-progress and one pending todo
//   edit  -> PreToolUse/PostToolUse Edit on <cwd>/src/app.ts (recap "files touched")
//   limit -> when <config dir>/fake-limited exists: prints Claude Code's "You've hit your session limit"
//            banner and fires StopFailure (error rate_limit); otherwise a normal turn
//   /login -> "logs in": writes oauthAccount.emailAddress to the account's .claude.json like Claude
//            Code does, prints "Login successful"
//   anything else -> UserPromptSubmit, PreToolUse, PostToolUse, "Done: <prompt>", Stop
// Env knobs: FAKE_CLAUDE_DELAY_MS (turn length, default 800), FAKE_CLAUDE_FAIL_RESUME=1
// (exit 1 right away on --resume, like Claude Code does for an unknown conversation),
// FAKE_CLAUDE_LOG=<file> (append every hook payload as a JSON line, for debugging),
// FAKE_CLAUDE_REAL_TRANSCRIPTS=1 (keep transcripts in <config dir>/projects/<encoded cwd>/ like Claude
// Code, and fail --resume when that file is missing). Config dir = CLAUDE_CONFIG_DIR or ~/.claude.
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

async function runTurn(prompt) {
  busy = true;
  appendTranscript({ type: 'user', message: { role: 'user', content: prompt } });
  await fireHook('UserPromptSubmit', { prompt });
  line('working…');

  if (prompt === 'ask') {
    await fireHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo fake' } });
    await fireHook('Notification', {
      notification_type: 'permission_prompt',
      message: 'Fake needs permission',
    });
    line('Fake needs permission. Allow? (y/n)');
    // Same shape as Claude Code's permission dialog: box, question, numbered options, a cursor
    const bar = '─'.repeat(58);
    line(`\x1b[38;2;177;185;249m╭${bar}╮\x1b[39m`);
    line('│ \x1b[1mBash command\x1b[22m');
    line('│');
    line('│   echo fake');
    line('│   \x1b[2mPrint a fake line\x1b[22m');
    line('│');
    line('│ Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?');
    line('│ \x1b[38;2;177;185;249m❯\x1b[1C1.\x1b[1CYes\x1b[39m');
    line("│   2. Yes, and don't ask again for echo commands in this folder");
    line('│   3. No, and tell Claude what to do differently \x1b[2m(esc)\x1b[22m');
    line(`\x1b[38;2;177;185;249m╰${bar}╯\x1b[39m`);
    busy = false;
    const answer = await new Promise((resolve) => {
      waitingForPermission = resolve;
    });
    busy = true;
    if (answer === 'y' || answer === '1' || answer === '2') {
      line('Permission granted');
      await fireHook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo fake' } });
    } else {
      line('Permission denied');
    }
    await sleep(TURN_DELAY_MS);
    line(`Done: ${prompt}`);
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: `Done: ${prompt}` });
  } else if (prompt === 'serve') {
    await fireHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run dev' } });
    const port = await startDevServer();
    line();
    line('  [32m[1mVITE[22m v7.0.0[39m  [2mready in [0m[1m123[22m[2m[0m ms');
    line();
    // Vite bolds the port in the middle of the URL; the detector has to see through that
    line(`  [32m➜[39m  [1mLocal[22m:   [36mhttp://localhost:[1m${port}[22m/[39m`);
    line('  [32m➜[39m  [1mNetwork[22m: [2muse [22m[1m--host[22m[2m to expose[22m');
    await sleep(TURN_DELAY_MS);
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
    await sleep(TURN_DELAY_MS);
    line('Done: plan');
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: 'Planned the work in three steps.' });
  } else if (prompt === 'edit') {
    const file = path.join(cwd, 'src', 'app.ts');
    await fireHook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
    await fireHook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
    await sleep(TURN_DELAY_MS);
    line('Done: edit');
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: 'Edited src/app.ts.' });
  } else if (/^usage(\s+\d+)?$/.test(prompt)) {
    const output = Number(prompt.split(/\s+/)[1] ?? 1234);
    await fireHook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: cwd } });
    writeUsageLine(output);
    await sleep(TURN_DELAY_MS / 2);
    line(`Done: ${prompt}`);
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: `Done: ${prompt}` });
  } else if (prompt === 'limit' && fs.existsSync(path.join(configDir, 'fake-limited'))) {
    await sleep(TURN_DELAY_MS / 4);
    const banner = "You've hit your session limit · resets 11pm (Europe/Brussels)";
    line(`[31m${banner.replace(/ /g, '[1C')}[39m`);
    await fireHook('StopFailure', { error: 'rate_limit', last_assistant_message: banner });
  } else if (prompt === 'fail') {
    await sleep(TURN_DELAY_MS / 2);
    line('API Error: fake overloaded');
    await fireHook('StopFailure', { error: 'Fake API error', last_assistant_message: 'API Error: fake overloaded' });
  } else {
    await fireHook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: cwd } });
    await fireHook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: cwd } });
    await sleep(TURN_DELAY_MS);
    line(`Done: ${prompt}`);
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: `Done: ${prompt}` });
  }
  busy = false;
  showPrompt();
}

let devServer = null;

// 'serve': one page on a free port, alive until this fake CLI exits
function startDevServer() {
  if (devServer) return Promise.resolve(devServer.address().port);
  return new Promise((resolve) => {
    devServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Fake dev server</title><body style="font:24px sans-serif;background:#f3efe6;padding:40px">' +
        '<h1 id="fake-dev">Fake dev server</h1><p>Served by the fake Claude CLI.</p></body>');
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
const DIALOG_KEYS = { 1: '1', 2: '2', 3: 'n', y: 'y', Y: 'y', n: 'n', N: 'n', '\x1b': 'n' };

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
  if (args.resume && realTranscripts && !fs.existsSync(transcriptPath)) {
    line(`No conversation found with session ID: ${args.resume}`);
    process.exit(1);
  }
  if (args.resume && process.env.FAKE_CLAUDE_FAIL_RESUME === '1') {
    line(`No conversation found with session ID: ${args.resume}`);
    process.exit(1);
  }

  line('\x1b[1m* Fake Claude Code\x1b[0m');
  line(`session ${sessionId}`);
  line(`cwd ${cwd}`);
  // Flags from Settings (--model, --permission-mode, extra flags); --mcp-config is always there
  const extra = args.rest.filter((a, i, all) => a !== '--mcp-config' && all[i - 1] !== '--mcp-config');
  if (extra.length) line(`args ${extra.join(' ')}`);
  if (args.resume) line(`resumed ${args.resume}`);
  if (process.env.CLAUDE_CONFIG_DIR) line(`config-dir ${process.env.CLAUDE_CONFIG_DIR}`);
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

  await fireHook('SessionStart', { source: args.resume ? 'resume' : 'startup', model: 'fake-model' });
  showPrompt();
}

void main();
