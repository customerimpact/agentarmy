import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev the UI runs on Vite (5173) and proxies API + WebSocket to the server (4317)
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // The board (index.html) and the phone page (phone.html, served by the phone server)
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'src/web/index.html'),
        phone: path.resolve(import.meta.dirname, 'src/web/phone.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});
