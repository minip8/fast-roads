import type { CarId } from '../cars';
import type { TrackId } from '../tracks';

// ============================================================================
// RL environment configuration: every number the environment uses, with its default. docs/ai-env.md documents each
// field; the worker sends the defaults in its handshake. A partial config is merged over the defaults (mergeConfig).
// ============================================================================

export interface ObsConfig {
  lookahead: number;           // track samples ahead of the car
  lookMinM: number;            // the samples reach lookMinM + lookSecs x forward speed ahead...
  lookSecs: number;
  lookPow: number;             // ...sample k of n (1..n) at reach x (k/n)^lookPow: denser near the car
}

export interface RewardConfig {
  progress: number;            // per metre of centreline progress (only while the car is on the track, out of the pit lane)
  wallHit: number;             // per m/s of the hardest impact speed into a wall during the step
  wallContact: number;         // per step with any wall contact
  offTrack: number;            // per second with all four wheels past the track limits (the game's definition)
  pitLane: number;             // per second in the pit lane (the game's definition: Timing's PIT LANE rule)
  steerSmooth: number;         // x (steer action - previous steer action)^2
  pedalSmooth: number;         // x (pedal action - previous pedal action)^2
  terminal: number;            // once, on a termination (not on a truncation)
}

export interface TerminationConfig {
  wrongWayM: number;           // terminated once this many metres behind the furthest point reached (0: off)
  stuckSecs: number;           // terminated after this long below stuckSpeed (0: off)
  stuckSpeed: number;          // m/s
  wallImpactMs: number;        // terminated on a wall hit at least this fast (m/s; 0: off)
}

export type StartMode = 'random' | 'flying';

// How an episode starts. Track and car: one id, or a list to draw from uniformly.
export interface ResetConfig {
  tracks: TrackId[];
  cars: CarId[];
  flyingProb: number;          // chance of the game's flying start instead of a random one ('random' start mode)
  start: StartMode;            // 'flying' always uses the flying start
  speedFrac: [number, number]; // random start: speed drawn from this range, x the autopilot's planned speed there
  latFrac: number;             // random start: lateral offset drawn from +-latFrac x (half-width - latMarginM)
  latMarginM: number;
  headingMax: number;          // random start: heading error drawn from +-headingMax (rad)
  eval: boolean;               // evaluation: flying start, the episode ends (truncated) when the first timed lap is done
}

export interface EnvConfig {
  actionHz: number;            // policy rate: 120 / actionHz physics ticks per action (must divide 120)
  actionMode: 'absolute' | 'delta';
  deltaScale: [steer: number, pedal: number];   // delta mode: change per step at action 1
  steerRate: number;           // the steering command slews at most this many full locks per second
  pedalRate: number;           // pedal axis slew limit, units per second (0: none)
  tc: boolean;                 // traction control (ABS is always on: neither engine can turn it off)
  episodeSecs: number;         // truncated after this much sim time (eval episodes: evalSecs)
  evalSecs: number;
  cacheSessions: number;       // physics worlds kept per environment (one per circuit, about 10 MB each); performance only
  obs: ObsConfig;
  reward: RewardConfig;
  termination: TerminationConfig;
  reset: ResetConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const DEFAULT_CONFIG: EnvConfig = {
  actionHz: 20,
  actionMode: 'absolute',
  deltaScale: [0.25, 0.5],
  steerRate: 3,
  pedalRate: 0,
  tc: true,
  episodeSecs: 90,
  evalSecs: 300,
  cacheSessions: 2,
  obs: { lookahead: 16, lookMinM: 40, lookSecs: 4, lookPow: 1.5 },
  reward: { progress: 1, wallHit: 1, wallContact: 0.2, offTrack: 5, pitLane: 5, steerSmooth: 0, pedalSmooth: 0, terminal: 20 },
  termination: { wrongWayM: 30, stuckSecs: 3, stuckSpeed: 1, wallImpactMs: 0 },
  reset: {
    tracks: ['melbourne'], cars: ['lcf1'], flyingProb: 0.1, start: 'random',
    speedFrac: [0.3, 1], latFrac: 0.6, latMarginM: 1.5, headingMax: 0.1, eval: false,
  },
};

// Deep merge of a partial config over a base (arrays are replaced, not merged). Unknown keys are an error, so a typo
// in the trainer's config does not silently do nothing.
export function mergeConfig<T extends object>(base: T, over: DeepPartial<T> | undefined, path = ''): T {
  if (over == null) return structuredClone(base);
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) throw new Error(`unknown config field ${path}${k}`);
    const b = out[k];
    if (v === undefined) continue;
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`config field ${path}${k} must be an object`);
      out[k] = mergeConfig(b as object, v as DeepPartial<object>, `${path}${k}.`);
    } else out[k] = structuredClone(v);
  }
  return out as T;
}
