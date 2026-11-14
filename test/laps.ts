import { expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import { session } from './harness';

// Autopilot lap times, pinned to the millisecond. The simulation is deterministic, so they only change when physics
// or car tuning changes. If you changed handling on purpose, check the car still behaves, then update them here.
// Each lap has its own test file (laps-*.test.ts), so Vitest runs the three in parallel.
const EXPECTED = {
  f1: { car: 'f1', tc: true, time: '119.659', limit: 150 },
  drift: { car: 'drift', tc: true, time: '172.145', limit: 200 },
  driftNoTc: { car: 'drift', tc: false, time: '172.217', limit: 200 },
} satisfies Record<string, { car: CarId; tc: boolean; time: string; limit: number }>;

export function lapTest(lap: keyof typeof EXPECTED) {
  const { car, tc, time, limit } = EXPECTED[lap];
  it(`${car} laps cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, async () => {
    const { timing, drive } = await session(car, { tc });
    drive(limit, null, () => timing.laps.length > 0);   // stops after the first lap; the limit catches a car that never gets there
    expect(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, true]]);
  });
}
