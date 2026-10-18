import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
// git@host:owner/repo(.git)  (scp-like ssh syntax)
const SCP_RE = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9_.~/-]+)$/;

export class CloneError extends Error {}

// Whitelist: https, ssh:// or scp-like ssh, or GitHub owner/repo. Everything else is refused,
// which also rules out option injection ("-u...") and dangerous transports (ext::, file://, fd::).
export function normalizeCloneUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new CloneError('url is required');
  const url = raw.trim();
  if (url.startsWith('-')) throw new CloneError('url cannot start with "-"');
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) throw new CloneError('url cannot contain spaces or control characters');
  if (url.includes('::')) throw new CloneError('git transport syntax ("::") is not allowed');

  const short = SHORTHAND_RE.exec(url);
  if (short && !url.includes(':')) {
    const [, owner, repo] = short;
    if ([owner, repo].some((p) => p === '.' || p === '..')) throw new CloneError('Invalid owner/repo');
    return `https://github.com/${owner}/${repo.endsWith('.git') ? repo : `${repo}.git`}`;
  }

  const scp = SCP_RE.exec(url);
  if (scp) {
    if (scp[3].startsWith('-') || scp[3].startsWith('/')) throw new CloneError('Invalid ssh path');
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CloneError('Use an https URL, git@host:owner/repo, or owner/repo');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw new CloneError(`Only https and ssh URLs are allowed (got ${parsed.protocol})`);
  }
  if (!parsed.hostname || parsed.hostname.startsWith('-')) throw new CloneError('Invalid host');
  return url;
}

// Last path segment without .git, e.g. https://github.com/a/b.git -> b
export function repoNameFromUrl(url: string): string {
  const pathPart = url.replace(/[?#].*$/, '').replace(/^[^@]+@[^:/]+:/, '');
  const last = pathPart.split('/').filter(Boolean).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  return NAME_RE.test(name) && name !== '.' && name !== '..' ? name : 'repo';
}

// parent/name, or parent/name-2, name-3... when taken
export function pickDestination(
  parent: string,
  name: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  let dest = path.join(parent, name);
  for (let n = 2; exists(dest); n++) dest = path.join(parent, `${name}-${n}`);
  return dest;
}

function lastLines(text: string, count = 6): string {
  return text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

export async function cloneRepo(
  rawUrl: unknown,
  rawParent: unknown,
  options: { timeoutMs?: number; git?: string } = {},
): Promise<{ path: string }> {
  const url = normalizeCloneUrl(rawUrl);
  if (typeof rawParent !== 'string' || !rawParent.trim()) throw new CloneError('parent is required');
  const parent = path.resolve(rawParent.trim());
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new CloneError(`Not a directory: ${parent}`);
  }
  const dest = pickDestination(parent, repoNameFromUrl(url));

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        // dest did not exist before (pickDestination), so this only removes our partial checkout
        try {
          fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // a killed git may still hold files on Windows; leave the leftovers
        }
        reject(err);
      } else resolve();
    };
    const child = spawn(options.git ?? 'git', ['clone', '--', url, dest], {
      cwd: parent,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new CloneError('git clone timed out after 10 minutes'));
    }, options.timeoutMs ?? CLONE_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new CloneError(
          err.code === 'ENOENT' ? 'git is not installed or not on PATH' : `Could not run git: ${err.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new CloneError(lastLines(stderr) || `git clone failed (exit code ${code})`));
    });
  });
  return { path: dest };
}
