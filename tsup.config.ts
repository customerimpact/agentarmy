import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/server/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['node-pty'],
});
