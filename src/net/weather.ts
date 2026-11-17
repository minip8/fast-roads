// ============================================================================
// A session's weather (docs/net.md, **Weather**): keyframes of (session time, rain intensity, track wetness),
// piecewise linear between them, which the relay generates from the room's weather setting and a seed and sends at
// the session start (and again, further ahead, when a session runs long). Pure and deterministic: the same kind,
// seed and keyframe index give the same keyframe on every machine. Imports nothing (the relay, also on Cloudflare,
// and the game share it).
//
// The model, one step a minute: rain comes in showers (a two-state Markov chain per kind: the chance a minute of a
// shower starting and of it stopping), each shower with its own intensity, which the rain ramps towards by at most
// 0.25 a minute. Wetness follows the rain: dW/dt = WET_RATE * r * (1 - W) - DRY_RATE * max(0, 1 - 3 r) * W, so
// heavy rain soaks the track in a few minutes, drizzle (r over a third) holds it, and it dries over a quarter of an
// hour once the rain stops. Both are quantised to 1/255, as on the wire.
// ============================================================================
export const WEATHER_KINDS = ['dry', 'damp', 'wet', 'changeable', 'random'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];
export type ResolvedWeather = Exclude<WeatherKind, 'random'>;

export interface WeatherKey {
  t: number;       // s from the session start (whole seconds, 0-65535)
  rain: number;    // rain intensity 0..1 (a multiple of 1/255)
  wet: number;     // track wetness 0..1 (a multiple of 1/255)
}
export interface Conditions { rain: number; wet: number }

export const WEATHER_STEP = 60;          // s between keyframes
export const MAX_WEATHER_KEYS = 64;      // in one message: 63 minutes ahead at one a minute
export const MAX_WEATHER_T = 65535;      // s: the last keyframe time the wire can carry (18 h)
const WET_RATE = 1 / 150, DRY_RATE = 1 / 900;   // 1/s
const SUBSTEPS = 12;

// Per kind: starting wetness [lo, hi], shower chance a minute (start, stop), shower intensity [lo, hi].
const MODEL: Record<Exclude<ResolvedWeather, 'dry'>, { wet0: [number, number]; start: number; stop: number; rain: [number, number] }> = {
  damp: { wet0: [0.3, 0.5], start: 0.08, stop: 0.35, rain: [0.05, 0.2] },
  wet: { wet0: [0.75, 0.95], start: 0.5, stop: 0.05, rain: [0.35, 0.85] },
  changeable: { wet0: [0, 0.3], start: 0.12, stop: 0.2, rain: [0.2, 0.9] },
};

// A small seeded generator (mulberry32): u32 seed -> uniform [0, 1).
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// What 'random' turns into for this seed (dry 40%, changeable 30%, damp 15%, wet 15%); any other kind is itself.
export function resolveWeather(kind: WeatherKind, seed: number): ResolvedWeather {
  if (kind !== 'random') return kind;
  const u = seededRandom((seed ^ 0x5bd1e995) >>> 0)();
  return u < 0.4 ? 'dry' : u < 0.7 ? 'changeable' : u < 0.85 ? 'damp' : 'wet';
}

// Keyframes `first` .. `first + count - 1` (keyframe i is at i * WEATHER_STEP s; none past MAX_WEATHER_T, but at least
// the last one there) of the
// weather of this kind and seed. Dry weather is two keyframes (0 and MAX_WEATHER_T) of nothing, whatever is asked.
export function weatherKeys(kind: WeatherKind, seed: number, first = 0, count = MAX_WEATHER_KEYS): WeatherKey[] {
  const k = resolveWeather(kind, seed);
  if (k === 'dry') return [{ t: 0, rain: 0, wet: 0 }, { t: MAX_WEATHER_T, rain: 0, wet: 0 }];
  const m = MODEL[k], rnd = seededRandom(seed);
  const end = Math.floor(MAX_WEATHER_T / WEATHER_STEP);
  first = Math.max(0, Math.min(Math.floor(first), end));   // (always at least one keyframe)
  const last = Math.min(first + Math.max(1, count) - 1, end);
  let wet = m.wet0[0] + rnd() * (m.wet0[1] - m.wet0[0]);
  let shower = rnd() < m.start / (m.start + m.stop);   // the chain's steady state
  let target = shower ? m.rain[0] + rnd() * (m.rain[1] - m.rain[0]) : 0;
  let rain = target;
  const out: WeatherKey[] = [];
  for (let i = 0; i <= last; i++) {
    if (i >= first) out.push({ t: i * WEATHER_STEP, rain: q8(rain), wet: q8(wet) });
    // the next minute: the shower starts or stops, its intensity wanders, the rain ramps, the track follows
    if (shower ? rnd() < m.stop : rnd() < m.start) {
      shower = !shower;
      target = shower ? m.rain[0] + rnd() * (m.rain[1] - m.rain[0]) : 0;
    } else if (shower) target = clamp(target + (rnd() - 0.5) * 0.2, m.rain[0], m.rain[1]);
    const next = rain + clamp(target - rain, -0.25, 0.25);
    for (let s = 0; s < SUBSTEPS; s++) {
      const r = rain + ((s + 0.5) / SUBSTEPS) * (next - rain), dt = WEATHER_STEP / SUBSTEPS;
      wet += dt * (WET_RATE * r * (1 - wet) - DRY_RATE * Math.max(0, 1 - 3 * r) * wet);
    }
    rain = next; wet = clamp(wet, 0, 1);
  }
  return out;
}

// The conditions at session time t (s) from keyframes in time order: linear between them, the first before the
// first, the last after the last; nothing (dry) with no keyframes.
export function weatherAt(keys: readonly WeatherKey[], t: number, out: Conditions = { rain: 0, wet: 0 }): Conditions {
  if (!keys.length) { out.rain = 0; out.wet = 0; return out; }
  if (!(t > keys[0].t)) { out.rain = keys[0].rain; out.wet = keys[0].wet; return out; }
  const z = keys[keys.length - 1];
  if (t >= z.t) { out.rain = z.rain; out.wet = z.wet; return out; }
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi], u = (t - a.t) / (b.t - a.t);
  out.rain = a.rain + u * (b.rain - a.rain); out.wet = a.wet + u * (b.wet - a.wet);
  return out;
}

const q8 = (x: number) => Math.round(clamp(x, 0, 1) * 255) / 255;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
