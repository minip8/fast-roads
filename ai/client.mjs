#!/usr/bin/env node
// Reference client for the RL environment worker (docs/ai-env.md), in plain Node with no dependencies: starts
// build/env/worker.mjs, does the handshake and drives it with random actions. Also a module: ai/bench.mjs and the
// tests use EnvWorker.
//
//   npm run build:env && node ai/client.mjs [numEnvs] [steps]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MSG = { hello: 0x01, init: 0x02, ready: 0x03, reset: 0x10, resetOk: 0x11, step: 0x20, stepOk: 0x21, error: 0x7e, close: 0x7f };
const HEADER = 8;
const pad8 = (n) => (n + 7) & ~7;
export const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'env', 'worker.mjs');

export class EnvWorker {
  // quiet: drop the worker's stderr (its log) instead of passing it through
  constructor(workerPath = WORKER, { quiet = false } = {}) {
    this.proc = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', quiet ? 'ignore' : 'inherit'] });
    this.buf = Buffer.alloc(0);
    this.waiting = [];   // resolvers for the next frames, in order
    this.frames = [];
    this.proc.stdout.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + len) break;
        // copied into its own ArrayBuffer at offset 0, so typed-array views of it are aligned
        const payload = new Uint8Array(len);
        payload.set(this.buf.subarray(4, 4 + len));
        this.buf = this.buf.subarray(4 + len);
        const w = this.waiting.shift();
        if (w) w(payload); else this.frames.push(payload);
      }
    });
    this.exited = new Promise((res) => this.proc.on('exit', res));
  }

  next() {
    const f = this.frames.shift();
    if (f) return Promise.resolve(f);
    return new Promise((res, rej) => {
      this.waiting.push(res);
      this.exited.then((code) => rej(new Error(`worker exited (${code})`)));
    });
  }
  sendFrame(type, arg, body) {
    const out = Buffer.alloc(4 + HEADER + body.byteLength);
    out.writeUInt32LE(HEADER + body.byteLength, 0);
    out.writeUInt8(type, 4);
    out.writeUInt32LE(arg, 8);
    Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(out, 4 + HEADER);
    this.proc.stdin.write(out);
  }
  async expect(type) {
    const p = await this.next();
    if (p[0] === MSG.error) throw new Error('worker: ' + JSON.parse(new TextDecoder().decode(p.subarray(HEADER))).error);
    if (p[0] !== type) throw new Error(`expected message ${type}, got ${p[0]}`);
    return p;
  }
  json(p) { return JSON.parse(new TextDecoder().decode(p.subarray(HEADER))); }
  sendJson(type, value) { const b = new TextEncoder().encode(JSON.stringify(value)); this.sendFrame(type, b.length, b); }

  async hello() { this.helloMsg = this.json(await this.expect(MSG.hello)); return this.helloMsg; }
  async init(numEnvs, seed = 0, config = {}) {
    this.sendJson(MSG.init, { numEnvs, seed, config });
    this.readyMsg = this.json(await this.expect(MSG.ready));
    this.n = numEnvs; this.D = this.readyMsg.obsSize; this.F = this.readyMsg.infoFields.length;
    return this.readyMsg;
  }
  async reset(options = {}) {
    this.sendJson(MSG.reset, options);
    const p = await this.expect(MSG.resetOk), v = new DataView(p.buffer);
    const N = v.getUint32(HEADER, true), D = v.getUint32(HEADER + 4, true), F = v.getUint32(HEADER + 8, true);
    const oObs = HEADER + 16, oInfo = pad8(oObs + 4 * N * D);
    return { obs: new Float32Array(p.buffer, oObs, N * D), info: new Float64Array(p.buffer, oInfo, N * F) };
  }
  // actions: Float32Array [N x 2]
  async step(actions) {
    this.sendFrame(MSG.step, this.n, actions);
    const p = await this.expect(MSG.stepOk), v = new DataView(p.buffer);
    const N = v.getUint32(HEADER, true), D = v.getUint32(HEADER + 4, true), F = v.getUint32(HEADER + 8, true), K = v.getUint32(HEADER + 12, true);
    const oObs = HEADER + 16, oRew = oObs + 4 * N * D, oTerm = oRew + 4 * N, oTrunc = oTerm + N;
    const oInfo = pad8(oTrunc + N), oDone = oInfo + 8 * N * F, oFinal = pad8(oDone + 4 * K);
    return {
      obs: new Float32Array(p.buffer, oObs, N * D), reward: new Float32Array(p.buffer, oRew, N),
      terminated: new Uint8Array(p.buffer, oTerm, N), truncated: new Uint8Array(p.buffer, oTrunc, N),
      info: new Float64Array(p.buffer, oInfo, N * F),
      done: new Uint32Array(p.buffer, oDone, K), finalObs: new Float32Array(p.buffer, oFinal, K * D),
    };
  }
  async close() { this.sendFrame(MSG.close, 0, new Uint8Array(0)); return this.exited; }
}

// Demo: random actions, a summary of what came back.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2] ?? 4), steps = Number(process.argv[3] ?? 200);
  const w = new EnvWorker();
  const hello = await w.hello();
  console.log(`protocol ${hello.protocol}, game ${hello.game.commit.slice(0, 9)}${hello.game.dirty ? ' (dirty)' : ''}, ${hello.tracks.length} tracks, cars ${hello.cars.join(' ')}`);
  const ready = await w.init(n, 1, { reset: { tracks: ['melbourne', 'monaco'], cars: hello.cars } });
  console.log(`${ready.numEnvs} envs, observation ${ready.obsSize} floats, actions ${ready.actionSpec.map((a) => a.name).join(', ')}`);
  await w.reset({});
  let state = 0x9e3779b9;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) / 4294967296) * 2 - 1; };
  const actions = new Float32Array(n * 2), F = w.F, iEnd = ready.infoFields.indexOf('end_reason');
  let ret = 0, ends = 0;
  const t0 = performance.now();
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < n; k++) { actions[2 * k] = rand() * 0.3; actions[2 * k + 1] = 0.3 + 0.7 * rand(); }
    const r = await w.step(actions);
    for (let k = 0; k < n; k++) ret += r.reward[k];
    for (const k of r.done) { ends++; console.log(`  env ${k} ended at step ${s}: ${ready.endReasons[r.info[k * F + iEnd]]}`); }
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(`${steps} steps x ${n} envs in ${dt.toFixed(2)} s (${((steps * n) / dt).toFixed(0)} env steps/s), total reward ${ret.toFixed(1)}, ${ends} episodes ended`);
  await w.close();
}
