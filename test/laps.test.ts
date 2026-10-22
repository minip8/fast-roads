import { describe, expect, it } from 'vitest';
import { session } from './harness';

// The simulation is deterministic, so autopilot lap times only change when physics or car tuning changes.
// If you changed handling on purpose, check the car still behaves, then update the expected time here.
describe('autopilot laps', () => {
  it('F1 laps in 1:59.659', async () => {
    const { timing, drive } = await session('f1');
    drive(150);
    expect(timing.laps.map((l) => l.time.toFixed(3))).toEqual(['119.659']);
  });

  for (const [tc, time] of [[true, '182.572'], [false, '187.424']] as const) {
    it(`drift car laps cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, async () => {
      const { timing, drive } = await session('drift', { tc });
      drive(200);
      expect(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, true]]);
    });
  }
});
