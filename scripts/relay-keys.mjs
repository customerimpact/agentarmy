// One-time setup of the relay signing key (run it yourself: npm run relay:keys).
// - Generates an Ed25519 key pair.
// - Private key -> Vercel env RELAY_PRIVATE_KEY (production + preview) for gridhive.dev, which signs
//   relay tokens. It is piped straight into `vercel env add`: never printed, never written to disk.
// - Public key -> relay/wrangler.toml (not secret), then the relay Worker is redeployed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicRaw = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privatePkcs8 = b64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

const run = (cmd, args, cwd, input) => {
  const res = spawnSync(cmd, args, { cwd, input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};

for (const target of ['production', 'preview']) {
  // --force replaces a key from an earlier run
  run('npx', ['vercel', 'env', 'add', 'RELAY_PRIVATE_KEY', target, '--force', '--sensitive'], path.join(root, 'site'), privatePkcs8);
}

const toml = path.join(root, 'relay', 'wrangler.toml');
const text = fs.readFileSync(toml, 'utf8').replace(/^RELAY_PUBLIC_KEY = ".*"$/m, `RELAY_PUBLIC_KEY = "${publicRaw}"`);
fs.writeFileSync(toml, text);
run('npx', ['wrangler', 'deploy'], path.join(root, 'relay'));

console.log('\nRelay key set. Commit relay/wrangler.toml (it only holds the public key).');
