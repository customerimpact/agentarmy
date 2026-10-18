#!/usr/bin/env node
// Fake Claude Code CLI for deterministic end-to-end tests. It understands the flags AgentArmy
// passes (--session-id, --resume, --settings), fires the hooks from the settings file like
// Claude Code does, and offers a tiny line editor with a few magic prompts:
//   ask   -> Notification(permission_prompt), waits for a "y" line, then Stop
//   fail  -> StopFailure
//   exit  -> SessionEnd, exit 0
//   crash -> exit 3
//   anything else -> UserPromptSubmit, PreToolUse, PostToolUse, "Done: <prompt>", Stop
// Env knobs: FAKE_CLAUDE_DELAY_MS (turn length, default 800), FAKE_CLAUDE_FAIL_RESUME=1
// (exit 1 right away on --resume, like Claude Code does for an unknown conversation),
// FAKE_CLAUDE_LOG=<file> (append every hook payload as a JSON line, for debugging).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const transcriptPath = path.join(os.tmpdir(), 'fake-claude', `${sessionId}.jsonl`);

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
  await fireHook('UserPromptSubmit', { prompt });
  line('working…');

  if (prompt === 'ask') {
    await fireHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo fake' } });
    await fireHook('Notification', {
      notification_type: 'permission_prompt',
      message: 'Fake needs permission',
    });
    line('Fake needs permission. Allow? (y/n)');
    busy = false;
    const answer = await new Promise((resolve) => {
      waitingForPermission = resolve;
    });
    busy = true;
    if (answer === 'y') {
      line('Permission granted');
      await fireHook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo fake' } });
    } else {
      line('Permission denied');
    }
    await sleep(TURN_DELAY_MS);
    line(`Done: ${prompt}`);
    await fireHook('Stop', { stop_hook_active: false, last_assistant_message: `Done: ${prompt}` });
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
  if (prompt === 'crash') {
    line('Fake crash');
    await exitWith(3);
    return;
  }
  void runTurn(prompt);
}

function onInput(chunk) {
  // Bracketed paste markers would otherwise end up in the prompt
  const text = chunk.replace(/\x1b\[20[01]~/g, '');
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
