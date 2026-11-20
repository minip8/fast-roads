import type { EnvConfig } from './config';
import { PHYSICS_HZ, type ControlConfig } from './control';
import { OBS_VERSION, observationSpec } from './observation';

// ============================================================================
// A trained policy in the game: the web policy file that ai/rl/export_web.py writes from the trainer's .npz, parsed
// and run here (pure TypeScript, no Node or DOM). The network is the trainer's deterministic actor, as ai/rl/policy_np.py
// runs it: the observation normalised, then an op list (linear, layernorm, relu, push, add), the action tanh of the
// first act_dim outputs. File layout (little-endian):
//
//     0   4 bytes    "FRPW"
//     4   u32        J, the JSON's byte length
//     8   J bytes    UTF-8 JSON: PolicyMeta (below)
//     pad to a multiple of 4 (zeros)
//     float32[]      the arrays, each at meta.arrays[name].offset (in floats from here), shape meta.arrays[name].shape
//
// Linear weights are [in, out] (y = x w + b). Arithmetic: every vector is float32 between ops, as numpy keeps it; the
// normaliser is float32 to the bit (Math.fround); sums are float64, then rounded (numpy's float32 sums go in an
// order of their own, so no order would match them to the bit: these are the closer of the two to the exact sum).
// ============================================================================
export const POLICY_MAGIC = 'FRPW';
export const POLICY_FORMAT = 'fast-roads-policy-web';

export type PolicyOp =
  | { op: 'linear'; w: string; b: string }
  | { op: 'layernorm'; w: string; b: string; eps: number }
  | { op: 'relu' } | { op: 'push' } | { op: 'add' };

// The environment config a policy was trained with: what the control and the observation need (control.ts), and TC.
export type PolicyEnv = ControlConfig & Pick<EnvConfig, 'tc'> & Partial<EnvConfig>;

export interface PolicyMeta {
  format: string; version: number;
  obs_dim: number; act_dim: number; obs_clip: number;
  obsVersion: number;                   // the observation layout it was trained on (OBS_VERSION)
  ops: PolicyOp[];
  arrays: Record<string, { offset: number; shape: number[] }>;
  env: PolicyEnv;                       // the effective environment config of the training run
  trained: { cars: string[]; tracks: string[] };
  provenance: Record<string, unknown>;  // run, env steps, evaluated lap...: free-form
}

// ---- the manifest (public/ai/policies.json): per car id, a default policy file and per-circuit specialists
export type PolicyManifest = Record<string, { default?: string; tracks?: Record<string, string> }>;

// The file to drive `car` at `track`: the circuit's specialist, else the car's default, else null (the built-in
// autopilot drives). Anything malformed in the manifest counts as absent.
export function pickPolicy(manifest: unknown, car: string, track: string): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const entry = (manifest as Record<string, unknown>)[car];
  if (!entry || typeof entry !== 'object') return null;
  const { default: def, tracks } = entry as { default?: unknown; tracks?: unknown };
  const special = tracks && typeof tracks === 'object' ? (tracks as Record<string, unknown>)[track] : undefined;
  if (typeof special === 'string' && special) return special;
  return typeof def === 'string' && def ? def : null;
}

type Step = () => void;

export class Policy {
  readonly obsDim: number; readonly actDim: number;
  readonly env: PolicyEnv;
  private readonly x0: Float32Array;    // the normalised observation, the network's input
  private readonly out: Float32Array;   // the last op's output
  private readonly steps: Step[] = [];
  private readonly mean: Float32Array; private readonly scale: Float32Array; private readonly clip: number;

  constructor(readonly meta: PolicyMeta, private readonly arrays: Record<string, Float32Array>) {
    const m = meta;
    if (m.format !== POLICY_FORMAT || m.version !== 1) throw new Error(`not a ${POLICY_FORMAT} version 1 file (${m.format} ${m.version})`);
    if (m.obsVersion !== OBS_VERSION) throw new Error(`policy trained on observation version ${m.obsVersion}; the game's is ${OBS_VERSION}: retrain or re-export it`);
    const env = m.env;
    for (const k of ['actionHz', 'actionMode', 'deltaScale', 'steerRate', 'pedalRate', 'tc', 'obs'] as const) {
      if (env?.[k] === undefined) throw new Error(`policy file has no env.${k}`);
    }
    if (!Number.isInteger(PHYSICS_HZ / env.actionHz)) throw new Error(`policy actionHz ${env.actionHz} does not divide ${PHYSICS_HZ}`);
    const D = observationSpec(env.obs).length;
    if (m.obs_dim !== D) throw new Error(`policy observes ${m.obs_dim} values; the game's observation for its obs config has ${D}`);
    if (m.act_dim !== 2) throw new Error(`policy has ${m.act_dim} actions, not 2`);
    this.obsDim = D; this.actDim = m.act_dim; this.env = env; this.clip = m.obs_clip;
    this.mean = this.array('obs_mean', [D]); this.scale = this.array('obs_scale', [D]);
    this.x0 = new Float32Array(D);
    // compile the ops into steps over preallocated buffers: no garbage per call
    let x = this.x0;
    const stack: Float32Array[] = [];
    for (const op of m.ops) {
      const n = x.length, src = x;
      switch (op.op) {
        case 'linear': {
          const w = this.arrays[op.w], b = this.arrays[op.b];
          const k = b?.length ?? 0;
          this.array(op.w, [n, k]); this.array(op.b, [k]);
          const y = new Float32Array(k), acc = new Float64Array(k);
          this.steps.push(() => linear(src, w, b, acc, y));
          x = y; break;
        }
        case 'layernorm': {
          const w = this.array(op.w, [n]), b = this.array(op.b, [n]), y = new Float32Array(n), eps = op.eps;
          this.steps.push(() => layerNorm(src, w, b, eps, y));
          x = y; break;
        }
        case 'relu':
          this.steps.push(() => { for (let i = 0; i < n; i++) if (!(src[i] > 0)) src[i] = 0; });
          break;
        case 'push': {
          const keep = new Float32Array(n);
          this.steps.push(() => keep.set(src));
          stack.push(keep); break;
        }
        case 'add': {
          const other = stack.pop();
          if (!other || other.length !== n) throw new Error('policy ops: add without a matching push');
          this.steps.push(() => { for (let i = 0; i < n; i++) src[i] = src[i] + other[i]; });
          break;
        }
        default: throw new Error(`unknown policy op ${(op as { op: string }).op}`);
      }
    }
    if (x.length < this.actDim) throw new Error(`policy output has ${x.length} values, fewer than ${this.actDim}`);
    this.out = x;
  }

  // The deterministic action for an observation (float32 [obsDim]), written into `act` ([steer, pedal] in [-1, 1]).
  run(obs: Float32Array, act: Float32Array = new Float32Array(this.actDim)): Float32Array {
    if (obs.length !== this.obsDim) throw new Error(`observation has ${obs.length} values, the policy ${this.obsDim}`);
    const x = this.x0, mean = this.mean, scale = this.scale, c = this.clip, f = Math.fround;
    for (let i = 0; i < x.length; i++) {
      const v = f(f(obs[i] - mean[i]) * scale[i]);
      x[i] = v > c ? c : v < -c ? -c : v;
    }
    for (const s of this.steps) s();
    for (let k = 0; k < this.actDim; k++) act[k] = Math.tanh(this.out[k]);
    return act;
  }

  private array(name: string, shape: number[]): Float32Array {
    const a = this.arrays[name], spec = this.meta.arrays[name];
    if (!a || !spec) throw new Error(`policy file has no array ${name}`);
    if (spec.shape.length !== shape.length || spec.shape.some((d, i) => d !== shape[i])) {
      throw new Error(`policy array ${name} is [${spec.shape}], expected [${shape}]`);
    }
    return a;
  }
}

// y = x w + b (w [in, out], row-major), summed in float64: a row of w at a time, so it is read in order. Zeros in x
// (after a ReLU, about half) are skipped. (Unrolled by 4: about 20% faster in V8 than the plain loop; a dot product
// per output over transposed weights was slower.)
function linear(x: Float32Array, w: Float32Array, b: Float32Array, acc: Float64Array, y: Float32Array) {
  const n = x.length, k = y.length, k4 = k & ~3;
  for (let j = 0; j < k; j++) acc[j] = b[j];
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const o = i * k;
    let j = 0;
    for (; j < k4; j += 4) {
      acc[j] += xi * w[o + j]; acc[j + 1] += xi * w[o + j + 1];
      acc[j + 2] += xi * w[o + j + 2]; acc[j + 3] += xi * w[o + j + 3];
    }
    for (; j < k; j++) acc[j] += xi * w[o + j];
  }
  y.set(acc);
}

// (x - mean) / sqrt(var + eps) w + b, the biased variance, as torch's LayerNorm.
function layerNorm(x: Float32Array, w: Float32Array, b: Float32Array, eps: number, y: Float32Array) {
  const n = x.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  const mu = s / n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mu; v += d * d; }
  const inv = 1 / Math.sqrt(v / n + eps);
  for (let i = 0; i < n; i++) y[i] = (x[i] - mu) * inv * w[i] + b[i];
}

// A web policy file (the layout above) -> Policy. Throws with a clear message on anything that does not fit.
export function parsePolicy(buf: ArrayBuffer): Policy {
  const bytes = new Uint8Array(buf), dv = new DataView(buf);
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== POLICY_MAGIC) throw new Error('not a policy file (no FRPW header)');
  const J = dv.getUint32(4, true);
  if (8 + J > bytes.length) throw new Error('policy file is cut short (its JSON)');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + J))) as PolicyMeta;
  const base = (8 + J + 3) & ~3, floats = (bytes.length - base) >> 2;
  const arrays: Record<string, Float32Array> = {};
  for (const [name, { offset, shape }] of Object.entries(meta.arrays ?? {})) {
    const n = shape.reduce((p, d) => p * d, 1);
    if (!(offset >= 0 && offset + n <= floats)) throw new Error(`policy array ${name} runs past the end of the file`);
    const a = new Float32Array(n);
    for (let i = 0, o = base + 4 * offset; i < n; i++, o += 4) a[i] = dv.getFloat32(o, true);   // (any byte order)
    arrays[name] = a;
  }
  return new Policy(meta, arrays);
}

// The policy for `car` at `track` from a folder holding policies.json and the files it names (public/ai/ in the game).
export type PolicyLoad = { ok: true; file: string; policy: Policy } | { ok: false; error: string };
export async function loadPolicyFor(base: string, car: string, track: string, get: typeof fetch = fetch): Promise<PolicyLoad> {
  // (no-cache: the files are replaced in place by better ones, and the service worker leaves them to the network)
  const fetchOk = async (url: string) => {
    const r = await get(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r;
  };
  try {
    const manifest: unknown = await (await fetchOk(`${base}policies.json`)).json();
    const file = pickPolicy(manifest, car, track);
    if (!file) return { ok: false, error: `no trained policy for ${car} at ${track} in ${base}policies.json` };
    const policy = parsePolicy(await (await fetchOk(base + file)).arrayBuffer());
    if (policy.meta.trained?.cars && !policy.meta.trained.cars.includes(car)) {
      return { ok: false, error: `${file} was trained on ${policy.meta.trained.cars.join(', ')}, not ${car}` };
    }
    return { ok: true, file, policy };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
