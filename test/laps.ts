import { expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import { TRACKS, type TrackId } from '../src/tracks';
import { session } from './harness';

// Autopilot lap times from the game's flying start, pinned to the millisecond. The simulation is deterministic, so
// they only change when physics or car tuning changes (or the start: TrackDef.startBack and .flying). If you changed handling on purpose, check the car still behaves, then update them here.
// Each lap has its own test file (laps-*.test.ts), so Vitest runs them in parallel.
const EXPECTED = {
  f1: { track: 'melbourne', car: 'f1', tc: true, time: '119.159', limit: 150 },
  drift: { track: 'melbourne', car: 'drift', tc: true, time: '157.514', limit: 200 },
  driftNoTc: { track: 'melbourne', car: 'drift', tc: false, time: '157.491', limit: 200 },
  silverstoneF1: { track: 'silverstone', car: 'f1', tc: true, time: '129.121', limit: 170 },
  silverstoneDrift: { track: 'silverstone', car: 'drift', tc: true, time: '169.794', limit: 220 },
  gt3: { track: 'melbourne', car: 'gt3', tc: true, time: '130.795', limit: 170 },
  silverstoneGt3: { track: 'silverstone', car: 'gt3', tc: true, time: '141.453', limit: 190 },
  // on LibreCorsa's engine (src/lc)
  lcGt3: { track: 'melbourne', car: 'lcgt3', tc: true, time: '133.917', limit: 170 },
  silverstoneLcGt3: { track: 'silverstone', car: 'lcgt3', tc: true, time: '144.234', limit: 190 },
  lcF1: { track: 'melbourne', car: 'lcf1', tc: true, time: '116.317', limit: 150 },
  silverstoneLcF1: { track: 'silverstone', car: 'lcf1', tc: true, time: '123.798', limit: 160 },
} satisfies Record<string, { track: TrackId; car: CarId; tc: boolean; time: string; limit: number }>;

export function lapTest(lap: keyof typeof EXPECTED) {
  const { track, car, tc, time, limit } = EXPECTED[lap];
  it(`${car} laps ${track} cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, async () => {
    const { timing, drive, car: c, track: tr } = await session(car, { tc, track, flying: true });
    const startS = tr.L - TRACKS[track].startBack, flying = TRACKS[track].flying[car];
    expect(c.speedF * 3.6).toBeCloseTo(flying, 0);
    let atStart = -1;   // the speed (km/h) passing the start spot again at the end of the lap
    drive(limit, null, () => {   // stops after the first lap; the limit catches a car that never gets there
      if (atStart < 0 && timing.lapStart != null && timing.next === 0 && c.proj.s >= startS && c.proj.s < tr.L - 1) atStart = c.speedF * 3.6;
      return timing.laps.length > 0;
    });
    expect(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, true]]);
    // the flying start is the speed the car really has there on a lap: retake TrackDef.flying if this drifts
    expect(atStart).toBeGreaterThan(flying - 2);
    expect(atStart).toBeLessThan(flying + 2);
  });
}
