/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Rapier's -compat package inlines its WebAssembly as a 2 MB base64 string. In the production build, swap that for
// the byte-identical .wasm file the package also ships: ~210 KB less to download (gzip), streaming compilation,
// and no base64 decode on the main thread. The build fails if the inline copy and the file ever differ, so the
// browser always runs exactly the binary the Node tests run (dev and tests keep the inline copy).
function rapierWasmFile(): Plugin {
  let swapped = false;
  return {
    name: 'rapier-wasm-file',
    apply: 'build',
    transform(code, id) {
      if (!/rapier3d-compat[\\/]rapier\.mjs$/.test(id)) return;
      swapped = true;
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
    buildEnd(err) {
      if (!err && !swapped) this.error('rapier-wasm-file: rapier.mjs was not in the build (package layout changed?); update this plugin');
    },
  };
}

// boot.ts loads the game with a dynamic import (so a failed download can be reported). List the game's chunks and
// the physics .wasm in index.html, so the browser fetches them alongside the boot module instead of after it.
function preloadGame(): Plugin {
  return {
    name: 'preload-game',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle, chunk: entry }) {
        if (!bundle || !entry) return;
        if (!entry.dynamicImports.length) throw new Error('preload-game: the entry no longer imports the game dynamically; update this plugin');
        const files = new Set<string>();
        const add = (f: string) => {
          const c = bundle[f];
          if (c?.type !== 'chunk' || files.has(f) || f === entry.fileName || entry.imports.includes(f)) return;
          files.add(f); c.imports.forEach(add);
        };
        entry.dynamicImports.forEach(add);
        const wasm = Object.values(bundle).filter((a) => a.type === 'asset' && a.fileName.endsWith('.wasm'));
        return [
          ...[...files].map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `./${f}` }, injectTo: 'head' as const })),
          ...wasm.map((a) => ({ tag: 'link', attrs: { rel: 'preload', as: 'fetch', type: 'application/wasm', crossorigin: true, href: `./${a.fileName}` }, injectTo: 'head' as const })),
        ];
      },
    },
  };
}

// Car model files (public/cars/<id>/model.glb, a few MB each) and their content hashes. The game asks for
// `<file>?v=<hash>` (carModels.ts), so a changed model is a new URL and no cache can serve a stale one.
const MODEL_DIR = 'public/cars';
function carModels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of readdirSync(MODEL_DIR)) {
    const file = `${MODEL_DIR}/${id}/model.glb`;
    try { out[`cars/${id}/model.glb`] = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12); } catch { /* no model */ }
  }
  return out;
}
const CAR_MODELS = carModels();

// Writes dist/sw.js (from src/sw.js) with the list of every built file to precache, and a version that changes
// whenever any of them does, so a new deploy installs a new service worker. The car models are not precached
// (most players never drive some cars): the service worker keeps each one the first time the game fetches it. Nor
// are the trained policies (public/ai/: only ?autopilot=rl fetches them, and they are replaced in place by better
// ones), nor the autopilot's ghost laps (public/ghosts/: one small file per car and circuit, fetched only with the
// Ghost car setting on Autopilot), which are left to the network.
function serviceWorker(): Plugin {
  let root = '', outDir = '';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) { root = config.root; outDir = resolve(root, config.build.outDir); },
    closeBundle() {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      const files = walk(outDir).map((f) => relative(outDir, f).split(sep).join('/')).filter((f) => f !== 'sw.js').sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const lazy = files.filter((f) => f in CAR_MODELS);
      if (lazy.length !== Object.keys(CAR_MODELS).length) this.error('service-worker: a car model is missing from the build');
      const urls = files.filter((f) => !lazy.includes(f) && !f.startsWith('ai/') && !f.startsWith('ghosts/')).map((f) => (f === 'index.html' ? './' : './' + f));
      const template = readFileSync(resolve(root, 'src/sw.js'), 'utf8');
      for (const p of ['__VERSION__', '__FILES__', '__LAZY__']) if (!template.includes(p)) this.error(`service-worker: src/sw.js has no ${p} placeholder`);
      const src = template
        .replace('__VERSION__', JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('__FILES__', JSON.stringify(urls))
        .replace('__LAZY__', JSON.stringify(lazy.map((f) => `./${f}?v=${CAR_MODELS[f]}`)));
      writeFileSync(join(outDir, 'sw.js'), src);
    },
  };
}

export default defineConfig({
  base: './',   // so the built dist/ folder works from any path
  define: { __CAR_MODELS__: JSON.stringify(CAR_MODELS) },
  plugins: [rapierWasmFile(), preloadGame(), serviceWorker()],
  build: {
    chunkSizeWarningLimit: 600,   // the three.js chunk is ~530 kB minified
    rolldownOptions: {
      output: {
        // Libraries in their own chunks, so a game-code change doesn't invalidate them in the browser cache.
        codeSplitting: { groups: [
          // the glTF loader only for the car models, fetched with the first one (carModels.ts)
          { name: 'gltf', test: /node_modules[\\/]three[\\/]examples[\\/]jsm[\\/](loaders[\\/]GLTFLoader|libs[\\/]meshopt_decoder)/, includeDependenciesRecursively: false },
          { name: 'three', test: /node_modules[\\/]three[\\/]/ },
          { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]/ },
          { name: 'librecorsa', test: /src[\\/]lc[\\/]vendor[\\/]/ },   // the vendored engine changes as rarely as a library
        ] },
      },
    },
  },
  // Only this checkout's tests (agents' git worktrees under .claude/ hold copies), in two sets: npm test runs `unit`
  // (everything in test/, with the pinned laps at Melbourne and Silverstone), npm run test:laps runs `laps` (the
  // pinned autopilot laps at every other circuit, a few minutes on a desktop CPU).
  test: {
    testTimeout: 60_000, setupFiles: ['test/setup.ts'],   // a lap simulates 2-3 minutes of driving
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/*.test.ts'] } },
      { extends: true, test: { name: 'laps', include: ['test/calendar/*.test.ts'], testTimeout: 300_000 } },   // three laps a file
    ],
  },
});
