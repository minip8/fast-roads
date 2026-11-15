import { expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import type { TrackId } from '../src/tracks';
import { session } from './harness';

// Autopilot lap times, pinned to the millisecond. The simulation is deterministic, so they only change when physics
// or car tuning changes. If you changed handling on purpose, check the car still behaves, then update them here.
// Each lap has its own test file (laps-*.test.ts), so Vitest runs them in parallel.
const EXPECTED = {
  f1: { track: 'melbourne', car: 'f1', tc: true, time: '119.659', limit: 150 },
  drift: { track: 'melbourne', car: 'drift', tc: true, time: '157.751', limit: 200 },
  driftNoTc: { track: 'melbourne', car: 'drift', tc: false, time: '157.726', limit: 200 },
  silverstoneF1: { track: 'silverstone', car: 'f1', tc: true, time: '129.714', limit: 170 },
  silverstoneDrift: { track: 'silverstone', car: 'drift', tc: true, time: '170.275', limit: 220 },
  gt3: { track: 'melbourne', car: 'gt3', tc: true, time: '131.738', limit: 170 },
  silverstoneGt3: { track: 'silverstone', car: 'gt3', tc: true, time: '142.291', limit: 190 },
} satisfies Record<string, { track: TrackId; car: CarId; tc: boolean; time: string; limit: number }>;

export function lapTest(lap: keyof typeof EXPECTED) {
  const { track, car, tc, time, limit } = EXPECTED[lap];
  it(`${car} laps ${track} cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, async () => {
    const { timing, drive } = await session(car, { tc, track });
    drive(limit, null, () => timing.laps.length > 0);   // stops after the first lap; the limit catches a car that never gets there
    expect(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, true]]);
  });
}
