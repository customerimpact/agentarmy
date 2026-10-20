import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The shared-board viewer for gridhive.dev/s/<id>: built into site/app (served under /app/,
// vercel.json rewrites /s/:id to /app/viewer.html). Run npm run build:viewer before deploying.
export default defineConfig({
  root: 'src/web',
  base: '/app/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../site/app',
    emptyOutDir: true,
    rollupOptions: { input: { viewer: path.resolve(import.meta.dirname, 'src/web/viewer.html') } },
  },
});
