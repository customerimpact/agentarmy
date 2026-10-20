#!/usr/bin/env node
// Fake `npm i -g <cli>` for the Agents & accounts hub e2e test: prints npm-like lines and writes a tiny
// CLI shim at the path given as argv[2] (a .cmd on Windows, a shell script elsewhere) whose --version
// prints argv[3] (default 0.0.1-fake). Exits 0, or with FAKE_INSTALL_EXIT.
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
const version = process.argv[3] || '0.0.1-fake';
const out = (s) => process.stdout.write(s);
if (!target) {
  console.error('usage: fake-install.mjs <shim path> [version]');
  process.exit(2);
}
out('npm warn fake install\r\n');
setTimeout(() => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform === 'win32') fs.writeFileSync(target, `@echo off\r\necho ${version}\r\n`);
  else fs.writeFileSync(target, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  out(`added 1 package in 1s\r\n`);
  process.exit(Number(process.env.FAKE_INSTALL_EXIT ?? 0));
}, 600);
