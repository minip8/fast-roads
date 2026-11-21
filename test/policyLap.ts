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
export function policyLaps(track: TrackId) {
  for (const car of Object.keys(CARS) as CarId[]) {
    it(`a trained policy laps ${track} in the ${car} as the trainer evaluated it`, async (ctx) => {
      const found = gamePolicy(car, track);
      if (!found) return ctx.skip(noGamePolicy(car, track));
      const { file, policy } = found;
      const ev = (policy.meta.provenance.eval as { track: string; car: string; lap_time: number | null; lap_valid: boolean }[] | undefined)
        ?.find((r) => r.track === track && r.car === car);
      if (!ev?.lap_time || !ev.lap_valid) throw new Error(`${file} has no valid evaluated lap at ${track} in its provenance`);
      const { timing, drive, session: s } = await session(car, { track, flying: true, tc: policy.env.tc });
      const drv = new PolicyDriver(policy, s);
      let resets = 0;
      s.onReset = () => { resets++; };
      drive(ev.lap_time + 40, () => drv.input(), () => timing.laps.length > 0);
      const lap = timing.laps[0];
      console.log(`${file} at ${track}: ${lap?.time.toFixed(3)} s in the game, ${ev.lap_time.toFixed(3)} s in the trainer's evaluation`);
      expect(lap?.valid).toBe(true);
      expect(resets).toBe(0);
      expect(Math.abs(lap.time - ev.lap_time)).toBeLessThan(1.5);
    });
  }
}
