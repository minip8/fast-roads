/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',   // so the built dist/ folder works from any path
  build: { chunkSizeWarningLimit: 3500 },   // Rapier embeds its ~2 MB WebAssembly in the JS bundle
  test: { testTimeout: 60_000, setupFiles: ['test/setup.ts'] },   // a lap simulates 2-3 minutes of driving
});
