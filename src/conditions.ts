import { clamp } from './util';

// ============================================================================
// Session conditions: how a session runs the cars' physics, whichever engine drives them. The Session owns them
// (Session.conditions, setConditions) and hands them to every car it has or builds; each engine maps them to its own
// model (LcCar: LibreCorsa's wear, water and temperatures; Car: the drift car's simple grip scale). The defaults are
// the time trial, which runs exactly as before conditions existed (the pinned laps): no wear, a dry track, and the
// temperatures the LibreCorsa engine always had.
// ============================================================================
export interface Conditions {
  // Tyre wear rate: 0 = no wear (time trial), 1 = real, higher to make a short race's tyres go off as a long one's
  // would. On the LibreCorsa cars it also scales graining, blistering and flat spots (the engine's tyreWearScale).
  wearScale: number;
  // Rain falling, 0 (none) .. 1 (heavy). Nothing in the physics reads it: the engines model the water on the road,
  // not the rain. It is here for whoever moves `wetness` (the race layer, from the relay's keyframes) and for the
  // visuals and sound.
  rain: number;
  // Water on the track, 0 (dry) .. 1 (flooded: standing water deeper than an intermediate clears). See waterMm.
  wetness: number;
  airC: number;                      // air temperature (deg C): tyre and brake cooling, tyre pressure
  trackC: number;                    // track surface temperature (deg C): tyre cooling through the contact patch
}

// The time trial: LibreCorsa's engine defaults (27 deg C air, 41 deg C track), which our LibreCorsa cars always ran at.
export const TIME_TRIAL: Readonly<Conditions> = Object.freeze({ wearScale: 0, rain: 0, wetness: 0, airC: 27, trackC: 41 });

// Conditions with every number finite and in range (a bad keyframe must not reach the physics); missing or
// non-finite fields take `base`'s.
export function normalizeConditions(c: Partial<Conditions>, base: Readonly<Conditions> = TIME_TRIAL): Conditions {
  const num = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    wearScale: clamp(num(c.wearScale, base.wearScale), 0, 100),
    rain: clamp(num(c.rain, base.rain), 0, 1),
    wetness: clamp(num(c.wetness, base.wetness), 0, 1),
    airC: clamp(num(c.airC, base.airC), -20, 60),
    trackC: clamp(num(c.trackC, base.trackC), -20, 80),
  };
}

export const sameConditions = (a: Readonly<Conditions>, b: Readonly<Conditions>) =>
  a.wearScale === b.wearScale && a.rain === b.rain && a.wetness === b.wetness && a.airC === b.airC && a.trackC === b.trackC;

// Water film on the road (mm) for a track wetness, as LibreCorsa's engine takes it: 3 mm at 1, rising with the square
// so the scale's lower half is the damp-to-wet range where the grip changes most. On the engine's own labels
// (wet-tyres.ts) the track is damp (0.08 mm) from 0.16, wet (0.5 mm) from 0.41 and has standing water (1.5 mm) from
// 0.71; at 1 it is past what a wet tyre clears at 200 km/h (3.1 mm), so even wets aquaplane on the straights.
export const MAX_WATER_MM = 3;
export function waterMm(wetness: number): number {
  const w = clamp(Number.isFinite(wetness) ? wetness : 0, 0, 1);
  return MAX_WATER_MM * w * w;
}

// The development URL flags (main.ts): ?wear= (wearScale), wet= (wetness), rain=, airc=, trackc= (deg C) and
// compound= (a CompoundId, fitted where the car has it). Null without any of them.
export function conditionsFromUrl(params: URLSearchParams): { conditions: Partial<Conditions>; compound?: CompoundId } | null {
  const keys = { wear: 'wearScale', wet: 'wetness', rain: 'rain', airc: 'airC', trackc: 'trackC' } as const;
  const conditions: Partial<Conditions> = {};
  let any = false;
  for (const [p, k] of Object.entries(keys)) {
    const v = params.get(p);
    if (v === null) continue;
    any = true;
    const n = Number(v);
    if (v !== '' && Number.isFinite(n)) conditions[k] = n;
  }
  const c = params.get('compound');
  if (c !== null) any = true;
  return any ? { conditions, compound: isCompoundId(c) ? c : undefined } : null;
}

// ----------------------------------------------------------------------------
// Tyre compounds, as the HUD and a race or pit-stop layer see them. Each car lists the ones it can fit
// (Vehicle.compounds); the colours are the usual Pirelli sidewall colours.
// ----------------------------------------------------------------------------
export type CompoundId = 'soft' | 'medium' | 'hard' | 'intermediate' | 'wet' | 'allweather';

export interface Compound {
  readonly id: CompoundId;
  readonly name: string;             // as the car's data names it ("Soft", "GT3 Soft", "Full Wet", ...)
  readonly letter: string;           // S M H I W, A for the drift car's all-weather tyre
  readonly colour: string;           // CSS colour of the sidewall band
  readonly rain: boolean;            // a treaded rain tyre (intermediate, wet)
}

export const COMPOUND_COLOURS: Record<CompoundId, string> = {
  soft: '#e8112d', medium: '#ffd12e', hard: '#f2f2f2', intermediate: '#43b02a', wet: '#1e6fd9', allweather: '#a7b0b8',
};
export const COMPOUND_IDS: readonly CompoundId[] = ['soft', 'medium', 'hard', 'intermediate', 'wet', 'allweather'];
export const isCompoundId = (s: unknown): s is CompoundId => typeof s === 'string' && (COMPOUND_IDS as readonly string[]).includes(s);

// How a fresh set goes on (Vehicle.fitTyres): 'blanket' as out of the tyre blankets (a pit stop, the start of a race:
// the engine's own blanket temperature and cold pressures), 'lap' already at the heat of a flying lap (the time
// trial's start).
export type FitHeat = 'blanket' | 'lap';

// What the autopilot plans with when the grip is not the dry, fresh-tyre grip its speed profile was built for
// (Vehicle.gripPlan): the share of that grip the car can count on at a speed (m/s), and a key that is the same exactly
// when `at` is, for caching the profile built from it.
export interface GripPlan {
  readonly key: string;
  at(speedMs: number): number;
}
