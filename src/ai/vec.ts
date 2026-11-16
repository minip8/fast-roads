import RAPIER from '@dimforge/rapier3d-compat';
import type { TrackId } from '../tracks';
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type EnvConfig } from './config';
import { INFO_FIELDS, loadTracks, RaceEnv, type ResetOptions } from './env';

// ============================================================================
// N environments stepped as a batch, with automatic resets, over flat buffers the worker sends as they are:
// obs [N x D] float32, reward [N] float32, terminated/truncated [N] uint8, info [N x F] float64, and for the
// environments whose episode ended in the last step, their final observation. As vector-env APIs do, an
// environment whose episode ended is reset at once: `obs` holds the first observation of its new episode, while
// reward, flags and info are those of the step that ended the old one.
// ============================================================================
const STICKY = ['track', 'car', 'start', 'eval'] as const;   // reset options kept for the automatic resets

export class VecEnv {
  readonly envs: RaceEnv[];
  readonly obsSize: number; readonly infoSize = INFO_FIELDS.length;
  readonly obs: Float32Array; readonly reward: Float32Array;
  readonly terminated: Uint8Array; readonly truncated: Uint8Array;
  readonly info: Float64Array;
  readonly finalObs: Float32Array;          // [N x D]: rows of `done` environments only
  readonly done: number[] = [];             // environments whose episode ended in the last step
  private readonly sticky: ResetOptions[];

  constructor(readonly n: number, readonly cfg: EnvConfig, seed = 0) {
    const probe = new RaceEnv(cfg);
    const D = (this.obsSize = probe.spec.length), F = this.infoSize;
    this.obs = new Float32Array(n * D); this.finalObs = new Float32Array(n * D);
    this.reward = new Float32Array(n); this.terminated = new Uint8Array(n); this.truncated = new Uint8Array(n);
    this.info = new Float64Array(n * F);
    // environment k draws from seed + k
    this.envs = Array.from({ length: n }, (_, k) =>
      new RaceEnv(cfg, (seed + k) >>> 0, this.obs.subarray(k * D, (k + 1) * D), this.info.subarray(k * F, (k + 1) * F)));
    this.sticky = Array.from({ length: n }, () => ({}));
  }

  static async create(n: number, config?: DeepPartial<EnvConfig>, seed = 0): Promise<VecEnv> {
    await RAPIER.init();
    const cfg = mergeConfig(DEFAULT_CONFIG, config);
    await loadTracks(cfg.reset.tracks);
    return new VecEnv(n, cfg, seed);
  }

  // Resets every environment. opts: one set for all, or one per environment (null: none). track, car, start and
  // eval stay in force for later automatic resets until another reset changes them; seed (applied as seed + k for
  // environment k when one set is given for all) and a pose apply to this reset only.
  async reset(opts: ResetOptions | (ResetOptions | null)[] = {}) {
    const per = Array.isArray(opts);
    if (per && opts.length !== this.n) throw new Error(`reset: ${opts.length} option sets for ${this.n} environments`);
    const need = new Set<TrackId>();
    for (let k = 0; k < this.n; k++) { const o = per ? opts[k] : opts; if (o?.track) need.add(o.track); }
    await loadTracks([...need]);
    for (let k = 0; k < this.n; k++) {
      const o: ResetOptions = { ...((per ? opts[k] : opts) ?? {}) };
      if (!per && o.seed !== undefined) o.seed = (o.seed + k) >>> 0;
      const st = this.sticky[k] as Record<string, unknown>;
      for (const key of STICKY) if (key in o) st[key] = o[key];
      this.envs[k].reset({ ...this.sticky[k], ...o });
      this.reward[k] = 0; this.terminated[k] = 0; this.truncated[k] = 0;
    }
    this.done.length = 0;
  }

  // actions: [N x 2] (steer, pedal); NaN in a row: the autopilot drives that environment for this step.
  step(actions: ArrayLike<number>) {
    if (actions.length !== this.n * 2) throw new Error(`step: ${actions.length} action values for ${this.n} environments`);
    const D = this.obsSize;
    this.done.length = 0;
    for (let k = 0; k < this.n; k++) {
      const e = this.envs[k], r = e.step(actions[2 * k], actions[2 * k + 1]);
      this.reward[k] = r.reward; this.terminated[k] = r.terminated ? 1 : 0; this.truncated[k] = r.truncated ? 1 : 0;
      if (r.terminated || r.truncated) {
        this.finalObs.set(e.obs, k * D);
        this.done.push(k);
        e.reset(this.sticky[k], false);
      }
    }
  }

  dispose() { for (const e of this.envs) e.dispose(); }
}
