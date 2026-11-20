import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPolicyFor, parsePolicy, pickPolicy, type Policy } from '../src/ai/policy';
import { OBS_VERSION } from '../src/ai/observation';

// Trained policies in the game (src/ai/policy.ts): the web policy file, inference against numpy's (the fixtures are
// ai/rl/tests/make_policy_fixture.py's: random weights for both actors the trainer exports, random observations and
// the actions ai/rl/policy_np.py gives), the checks that refuse a file the game cannot drive with, and the manifest.

const file = (name: string) => { const b = readFileSync(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const fixture = (kind: string) => file(`test/fixtures/policy-${kind}.bin`);
const parity = JSON.parse(readFileSync('test/fixtures/policy-parity.json', 'utf8')) as { obs: number[][]; simba: number[][]; mlp: number[][] };

// The file with its JSON edited (the arrays move with the padding, so they are written again at the new offset).
function edit(buf: ArrayBuffer, f: (meta: Record<string, unknown>) => void): ArrayBuffer {
  const dv = new DataView(buf), J = dv.getUint32(4, true), base = (8 + J + 3) & ~3;
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, J)));
  f(meta);
  const js = new TextEncoder().encode(JSON.stringify(meta)), nb = (8 + js.length + 3) & ~3, data = new Uint8Array(buf, base);
  const out = new Uint8Array(nb + data.length);
  out.set(new TextEncoder().encode('FRPW')); new DataView(out.buffer).setUint32(4, js.length, true);
  out.set(js, 8); out.set(data, nb);
  return out.buffer;
}

describe('policy inference', () => {
  for (const kind of ['simba', 'mlp'] as const) {
    it(`gives numpy's actions for the ${kind} actor, to 1e-5`, () => {
      const p = parsePolicy(fixture(kind)), act = new Float32Array(2);
      let worst = 0;
      parity.obs.forEach((o, n) => {
        p.run(Float32Array.from(o), act);
        for (let k = 0; k < 2; k++) worst = Math.max(worst, Math.abs(act[k] - parity[kind][n][k]));
      });
      expect(worst).toBeLessThan(1e-5);
      // the same observation again: the same action (no state between calls)
      const a = p.run(Float32Array.from(parity.obs[3])).slice(), b = p.run(Float32Array.from(parity.obs[3]));
      expect(b).toEqual(a);
    });
  }

  it('refuses a file the game cannot drive with, saying why', () => {
    const buf = fixture('mlp');
    expect(() => parsePolicy(new ArrayBuffer(16))).toThrow(/not a policy file/);
    expect(() => parsePolicy(edit(buf, (m) => { m.obsVersion = OBS_VERSION - 1; }))).toThrow(/observation version/);
    expect(() => parsePolicy(edit(buf, (m) => { m.obs_dim = 150; }))).toThrow(/observes 150 values/);
    expect(() => parsePolicy(edit(buf, (m) => { (m.env as { obs: { lookahead: number } }).obs.lookahead = 12; }))).toThrow(/observes 145 values.*125/);
    expect(() => parsePolicy(edit(buf, (m) => { delete (m.env as Record<string, unknown>).steerRate; }))).toThrow(/env.steerRate/);
    expect(() => parsePolicy(edit(buf, (m) => { (m.env as { actionHz: number }).actionHz = 7; }))).toThrow(/actionHz/);
    expect(() => parsePolicy(buf.slice(0, buf.byteLength - 8))).toThrow(/past the end/);
  });

  it('runs a real policy in a fraction of a millisecond', () => {
    const p: Policy = parsePolicy(file('public/ai/lcf1-melbourne.bin')), obs = Float32Array.from(parity.obs[0]), act = new Float32Array(2);
    for (let k = 0; k < 200; k++) p.run(obs, act);   // (warm up the JIT)
    const n = 500, t0 = performance.now();
    for (let k = 0; k < n; k++) p.run(obs, act);
    const ms = (performance.now() - t0) / n;
    console.log(`policy ${p.meta.provenance.run}: ${ms.toFixed(3)} ms per call`);
    expect(ms).toBeLessThan(3);   // (loose, for a busy machine: about 0.1 ms for a 256 x 256 MLP actor, 0.5 for a 256-wide SimBa one)
    expect([...act].every((v) => Math.abs(v) <= 1)).toBe(true);
  });
});

describe('policy manifest', () => {
  const manifest = { lcf1: { default: 'lcf1.bin', tracks: { melbourne: 'lcf1-melbourne.bin' } }, lcgt3: { tracks: { monza: 'gt3-monza.bin' } } };
  it("picks the circuit's specialist, else the car's default, else none", () => {
    expect(pickPolicy(manifest, 'lcf1', 'melbourne')).toBe('lcf1-melbourne.bin');
    expect(pickPolicy(manifest, 'lcf1', 'monza')).toBe('lcf1.bin');
    expect(pickPolicy(manifest, 'lcgt3', 'monza')).toBe('gt3-monza.bin');
    expect(pickPolicy(manifest, 'lcgt3', 'spa')).toBeNull();
    expect(pickPolicy(manifest, 'drift', 'melbourne')).toBeNull();
  });
  it('treats anything malformed as absent', () => {
    for (const m of [null, 3, 'x', [], { lcf1: 'a.bin' }, { lcf1: { default: 7, tracks: [] } }, { lcf1: { default: '', tracks: { melbourne: '' } } }]) {
      expect(pickPolicy(m, 'lcf1', 'melbourne')).toBeNull();
    }
    expect(pickPolicy({ lcf1: { default: 'd.bin', tracks: { melbourne: 5 } } }, 'lcf1', 'melbourne')).toBe('d.bin');
  });
  it('loads through the manifest, and says why when it cannot', async () => {
    const files: Record<string, ArrayBuffer | object> = {
      'ai/policies.json': { lcf1: { tracks: { melbourne: 'p.bin' } }, lcgt3: { default: 'missing.bin' }, drift: { default: 'p.bin' } },
      'ai/p.bin': fixture('simba'),
    };
    const get = (async (url: string) => {
      const f = files[url];
      if (!f) return new Response(null, { status: 404 });
      return new Response(f instanceof ArrayBuffer ? f : JSON.stringify(f));
    }) as typeof fetch;
    const ok = await loadPolicyFor('ai/', 'lcf1', 'melbourne', get);
    expect(ok.ok && ok.file).toBe('p.bin');
    const none = await loadPolicyFor('ai/', 'lcf1', 'monza', get);
    expect(!none.ok && none.error).toMatch(/no trained policy for lcf1 at monza/);
    const missing = await loadPolicyFor('ai/', 'lcgt3', 'monza', get);
    expect(!missing.ok && missing.error).toMatch(/missing\.bin: HTTP 404/);
    const fresh = await loadPolicyFor('other/', 'lcf1', 'melbourne', get);
    expect(!fresh.ok && fresh.error).toMatch(/policies\.json: HTTP 404/);
    // (the fixture says it was trained on all three cars; a file trained on other cars is refused)
    files['ai/p.bin'] = edit(fixture('simba'), (m) => { (m.trained as { cars: string[] }).cars = ['lcgt3']; });
    const wrong = await loadPolicyFor('ai/', 'drift', 'melbourne', get);
    expect(!wrong.ok && wrong.error).toMatch(/trained on lcgt3, not drift/);
  });
});
