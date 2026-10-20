#!/usr/bin/env node
// Generic fake for custom-command consoles: prints a line every 150 ms for FAKE_TASK_MS (default
// 1500 ms), then "task idle" and goes quiet. Typing "again" + Enter streams once more, "quit" exits 0.
const RUN_MS = Number(process.env.FAKE_TASK_MS ?? 1500);
const out = (s) => process.stdout.write(s);

function run() {
  let n = 0;
  const timer = setInterval(() => out(`task output ${++n}\r\n`), 150);
  setTimeout(() => {
    clearInterval(timer);
    out('task idle\r\n$ ');
  }, RUN_MS);
}

let line = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  for (const ch of data) {
    if (ch === '\x03') process.exit(130);
    if (ch === '\r' || ch === '\n') {
      const text = line.trim();
      line = '';
      out('\r\n');
      if (text === 'quit') process.exit(0);
      if (text === 'again') run();
      else out('$ ');
    } else if (ch >= ' ') {
      line += ch;
      out(ch);
    }
  }
});
out('fake task starting\r\n');
run();
