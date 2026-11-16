import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The RL environment worker (ai/worker.ts) as one self-contained Node module, build/env/worker.mjs: the circuits'
// CSVs, three.js and Rapier (with its inline WebAssembly) bundled in, nothing to install next to it. Separate from
// the site's build (vite.config.ts), which never imports src/ai. `npm run build:env`.
const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim(); } catch { return ''; } };

export default defineConfig({
  publicDir: false,
  define: {
    __GAME_COMMIT__: JSON.stringify(git('rev-parse HEAD') || 'unknown'),
    __GAME_DIRTY__: JSON.stringify(git('status --porcelain') !== ''),
    __GAME_BUILT__: JSON.stringify(new Date().toISOString()),
    __CAR_MODELS__: '{}',
  },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'ai/worker.ts',
    outDir: 'build/env',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rolldownOptions: { output: { entryFileNames: 'worker.mjs', codeSplitting: false } },
  },
});
