import { defineConfig } from 'tsup';

// Desktop app (Electron) build: `npm run desktop:build`. Separate from tsup.config.ts so
// `npm run build` (and the npm package) stay exactly as before.
export default defineConfig([
  // Main process (ESM). Runtime dependencies (fastify, node-pty, ...) stay external and come from the
  // packaged node_modules; devDependencies such as electron-updater are bundled, so the npm package
  // never has to list them.
  {
    entry: { main: 'src/desktop/main.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    outDir: 'dist/desktop',
    clean: true,
    external: ['electron', 'node-pty'],
    noExternal: ['electron-updater'],
    // Bundled CommonJS (electron-updater) calls require(); give the ESM bundle a real one
    banner: {
      js: "import { createRequire as __aaCreateRequire } from 'node:module'; const require = __aaCreateRequire(import.meta.url);",
    },
  },
  // Sandboxed preload: one CommonJS file that only requires 'electron'
  {
    entry: { preload: 'src/desktop/preload.ts' },
    format: ['cjs'],
    target: 'chrome140',
    platform: 'browser',
    outDir: 'dist/desktop',
    clean: false,
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
