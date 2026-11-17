import { defineConfig } from 'vite';

// The multiplayer relay (server/main.ts) as one Node module, build/server/server.mjs, with src/net bundled in and
// `ws` left as an import (the relay's only dependency, installed with the site's; the site never imports it).
// `npm run server` builds and starts it.
export default defineConfig({
  publicDir: false,
  ssr: { external: ['ws'], target: 'node' },
  build: {
    ssr: 'server/main.ts',
    outDir: 'build/server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rolldownOptions: { output: { entryFileNames: 'server.mjs', codeSplitting: false } },
  },
});
