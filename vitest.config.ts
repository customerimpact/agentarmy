import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is src/web and would hide server tests
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'site/api/**/*.test.mjs'],
  },
});
