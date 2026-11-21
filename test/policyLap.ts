import { expect, it } from 'vitest';
import { PolicyDriver } from '../src/ai/policyDriver';
import { CARS, type CarId } from '../src/cars';
import type { TrackId } from '../src/tracks';
import { session } from './harness';
import { gamePolicy, noGamePolicy } from './policies';

// The game's trained policy for each car at a circuit (public/ai/: the circuit's specialist, or the car's default)
// laps the game's Session from the flying start, as test/laps.ts does for the autopilot: a valid lap, no resets, in
// the time the trainer's evaluation gave that policy there (its file's provenance). The trainer ran it with float32
// inference in torch or numpy and the game runs it in TypeScript (policy.ts): actions agree to about 1e-6, but a lap
// is long enough for that to move the line: by tenths as a rule, by a second where one corner goes differently (the
// GT3's Madrid specialist ranges over 0.3 s in twelve noisy laps and was 1.2 s off the one lap its file records). A car the manifest names no policy for is skipped.
type EvalLap = { track: string; car: string; lap_time: number | null; lap_valid: boolean; laps?: [number, boolean][] };
const STINT = 3;   // laps on end, for a policy whose file records a stint

export function policyLaps(track: TrackId) {
  for (const car of Object.keys(CARS) as CarId[]) {
    it(`a trained policy laps ${track} in the ${car} as the trainer evaluated it`, async (ctx) => {
      const found = gamePolicy(car, track);
      if (!found) return ctx.skip(noGamePolicy(car, track));
      const { file, policy } = found;
      const ev = (policy.meta.provenance.eval as EvalLap[] | undefined)?.find((r) => r.track === track && r.car === car);
      if (!ev?.lap_time || !ev.lap_valid) throw new Error(`${file} has no valid evaluated lap at ${track} in its provenance`);
      // A policy evaluated over a stint keeps lapping here too, as it does in the game (the car is not restarted
      // after a lap): the tyres get hotter than any single lap leaves them. One evaluated on a single lap drives one.
      const want = ev.laps ? ev.laps.slice(0, STINT).map((l) => l[0]) : [ev.lap_time];
      const { timing, drive, session: s } = await session(car, { track, flying: true, tc: policy.env.tc });
      const drv = new PolicyDriver(policy, s);
      let resets = 0;
      s.onReset = () => { resets++; };
      drive(want.reduce((a, b) => a + b, 0) + 60, () => drv.input(), () => timing.laps.length >= want.length);
      const laps = timing.laps.slice().reverse().slice(0, want.length);   // (timing.laps: the newest first)
      console.log(`${file} at ${track}: ${laps.map((l) => l.time.toFixed(3) + (l.valid ? '' : '!')).join(' ')} s in the game, ${want.map((t) => t.toFixed(3)).join(' ')} s in the trainer's evaluation`);
      expect(resets).toBe(0);
      expect(laps.map((l) => l.valid)).toEqual(want.map(() => true));
      laps.forEach((l, k) => expect(Math.abs(l.time - want[k])).toBeLessThan(1.5));
    });
  }
}
