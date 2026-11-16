// ============================================================================
// RL environment worker: N environments (src/ai/vec.ts) driven over stdin/stdout by a trainer, in the protocol of
// src/ai/protocol.ts (docs/ai-env.md). Built by `npm run build:env` into build/env/worker.mjs, a single file with
// the circuits, three.js and Rapier inside; run it with `node build/env/worker.mjs`. stdout carries protocol frames
// only: everything else (console output from any module included) goes to stderr.
// ============================================================================
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type EnvConfig } from '../src/ai/config';
import { helloJson, jsonFrame, MSG, parseJsonBody, readyJson, resetOkFrame, splitFrames, stepOkFrame } from '../src/ai/protocol';
import type { ResetOptions } from '../src/ai/env';
import { VecEnv } from '../src/ai/vec';

declare const __GAME_COMMIT__: string, __GAME_DIRTY__: boolean, __GAME_BUILT__: string;

// stdout is the protocol's: send any stray logging to stderr
console.log = console.info = console.debug = console.error;
// The lap timing keeps best times in localStorage: a worker keeps none (every episode starts with empty best times)
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 },
});

const send = (frame: Uint8Array) => { process.stdout.write(frame); };
let vec: VecEnv | null = null;

async function handle(payload: Uint8Array) {
  const type = payload[0];
  switch (type) {
    case MSG.init: {
      const msg = parseJsonBody(payload) as { numEnvs?: number; seed?: number; config?: DeepPartial<EnvConfig> };
      const n = msg.numEnvs ?? 1, seed = msg.seed ?? 0;
      if (!(Number.isInteger(n) && n >= 1 && n <= 4096)) throw new Error('numEnvs must be an integer from 1 to 4096');
      vec?.dispose();
      vec = null;
      const cfg = mergeConfig(DEFAULT_CONFIG, msg.config);
      vec = await VecEnv.create(n, cfg, seed);
      send(jsonFrame(MSG.ready, readyJson(vec, cfg, vec.envs[0].spec, seed)));
      return;
    }
    case MSG.reset: {
      if (!vec) throw new Error('reset before init');
      await vec.reset(parseJsonBody(payload) as ResetOptions | (ResetOptions | null)[]);
      send(resetOkFrame(vec));
      return;
    }
    case MSG.step: {
      if (!vec) throw new Error('step before init');
      const n = new DataView(payload.buffer, payload.byteOffset).getUint32(4, true);
      if (n !== vec.n || payload.length !== 8 + 8 * n) throw new Error(`step: expected ${vec.n} environments x 2 float32 actions`);
      // copied out: the frame's bytes need not be 4-byte aligned in the input buffer
      const actions = new Float32Array(payload.slice(8).buffer);
      vec.step(actions);
      send(stepOkFrame(vec));
      return;
    }
    case MSG.close:
      vec?.dispose();
      process.exit(0);
    // falls through (exit does not return)
    default:
      throw new Error(`unknown message type ${type}`);
  }
}

async function main() {
  send(jsonFrame(MSG.hello, helloJson({ commit: __GAME_COMMIT__, dirty: __GAME_DIRTY__, builtAt: __GAME_BUILT__ })));
  let pending: Uint8Array = new Uint8Array(0);
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    const buf = new Uint8Array(pending.length + chunk.length);
    buf.set(pending); buf.set(chunk, pending.length);
    const { frames, rest } = splitFrames(buf);
    pending = rest.slice();
    for (const f of frames) {
      try { await handle(f); }
      catch (e) {
        console.error(e);
        send(jsonFrame(MSG.error, { error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }
  vec?.dispose();   // stdin closed: the trainer has gone
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
