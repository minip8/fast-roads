import { defineConfig } from 'vite';

export default defineConfig({
  base: './',   // so the built dist/ folder works from any path
  build: { chunkSizeWarningLimit: 3500 },   // Rapier embeds its ~2 MB WebAssembly in the JS bundle
});
