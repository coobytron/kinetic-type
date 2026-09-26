import { defineConfig } from 'vitest/config';

// Relative base so the build works on a GitHub Pages project URL and inside an iframe embed.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2600 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
