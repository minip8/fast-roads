/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Rapier's -compat package inlines its WebAssembly as a 2 MB base64 string. In the production build, swap that for
// the byte-identical .wasm file the package also ships: ~210 KB less to download (gzip), streaming compilation,
// and no base64 decode on the main thread. The build fails if the inline copy and the file ever differ, so the
// browser always runs exactly the binary the Node tests run (dev and tests keep the inline copy).
function rapierWasmFile(): Plugin {
  return {
    name: 'rapier-wasm-file',
    apply: 'build',
    transform(code, id) {
      if (!/rapier3d-compat[\\/]rapier\.mjs$/.test(id)) return;
      const inline = /\b[\w$]+\.toByteArray\("([A-Za-z0-9+/=]{100000,})"\)\.buffer/g;
      const found = [...code.matchAll(inline)];
      const wasm = readFileSync(join(dirname(id), 'rapier_wasm3d_bg.wasm'));
      if (found.length !== 1 || !Buffer.from(found[0][1], 'base64').equals(wasm)) {
        this.error('rapier-wasm-file: the inline WebAssembly in rapier.mjs is not the shipped .wasm; update this plugin');
      }
      const ref = this.emitFile({ type: 'asset', name: 'rapier_wasm3d_bg.wasm', source: wasm });
      // the bundled wasm-bindgen init takes { module_or_path } and fetches it with instantiateStreaming
      return code.replace(found[0][0], () => `{ module_or_path: import.meta.ROLLUP_FILE_URL_${ref} }`);
    },
  };
}

export default defineConfig({
  base: './',   // so the built dist/ folder works from any path
  plugins: [rapierWasmFile()],
  build: {
    chunkSizeWarningLimit: 600,   // the three.js chunk is ~530 kB minified
    rolldownOptions: {
      output: {
        // Libraries in their own chunks, so a game-code change doesn't invalidate them in the browser cache.
        codeSplitting: { groups: [
          { name: 'three', test: /node_modules[\\/]three[\\/]/ },
          { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]/ },
        ] },
      },
    },
  },
  test: { testTimeout: 60_000, setupFiles: ['test/setup.ts'] },   // a lap simulates 2-3 minutes of driving
});
