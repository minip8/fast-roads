import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvWorker, MSG } from '../ai/client.mjs';
import type { CarId } from '../src/cars';
import type { TrackId } from '../src/tracks';
import { PROTOCOL_VERSION } from '../src/ai/protocol';
import { VecEnv } from '../src/ai/vec';

// The RL worker as the trainer runs it: built by vite.env.config.ts (into a temporary folder), started as its own
// Node process, driven over the binary protocol by the reference client (ai/client.mjs). It must agree bit for bit
// with the same environments run in this process.

let dir = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fastroads-env-'));
  await build({ configFile: 'vite.env.config.ts', logLevel: 'silent', build: { outDir: dir, sourcemap: false } });
}, 60_000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('worker', () => {
  it('handshakes, resets and steps over the protocol, as the environments do in-process', async () => {
    const w = new EnvWorker(join(dir, 'worker.mjs'), { quiet: true });   // its stderr would show the error provoked below
    const hello = await w.hello();
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    expect(hello.game.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(hello.tracks).toContain('monaco');
    const config = { episodeSecs: 2, reset: { tracks: ['melbourne', 'monaco'] as TrackId[], cars: ['lcf1', 'lcgt3', 'drift'] as CarId[] } };
    const ready = await w.init(3, 21, config);
    expect(ready.obsSpec.length).toBe(ready.obsSize);

    const local = await VecEnv.create(3, config, 21);
    const first = await w.reset({});
    await local.reset({});
    expect(first.obs).toEqual(local.obs);
    expect(first.info).toEqual(local.info);

    const a = new Float32Array(6);
    let ended = 0;
    for (let s = 0; s < 50; s++) {
      for (let k = 0; k < 6; k++) a[k] = k % 2 ? 0.8 : 0.2 * Math.sin(s * 0.3 + k);
      if (s % 10 === 0) a[0] = a[1] = Number.NaN;   // the autopilot drives env 0 now and then
      const r = await w.step(a);
      local.step(a);
      expect(r.obs).toEqual(local.obs);   // bit for bit, across processes
      expect(r.reward).toEqual(local.reward);
      expect(r.info).toEqual(local.info);
      expect([...r.terminated]).toEqual([...local.terminated]);
      expect([...r.truncated]).toEqual([...local.truncated]);
      expect([...r.done]).toEqual(local.done);
      local.done.forEach((k, j) => expect(r.finalObs.subarray(j * w.D, (j + 1) * w.D)).toEqual(local.finalObs.subarray(k * w.D, (k + 1) * w.D)));
      ended += r.done.length;
    }
    expect(ended).toBe(3);   // every episode truncated at 2 s, 40 steps in
    local.dispose();

    // a bad message is answered with an error, and the worker carries on
    w.sendFrame(MSG.step, 2, new Uint8Array(16));
    await expect(w.expect(MSG.stepOk)).rejects.toThrow(/expected 3 environments/);
    expect((await w.reset({ car: 'drift', start: 'flying' })).obs.length).toBe(3 * w.D);
    expect(await w.close()).toBe(0);
  }, 60_000);
});
