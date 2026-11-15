// The 2026 F1 on LibreCorsa's engine in the game's session (the suite is in lc-car.ts): its flaps and hybrid too.
import { describe, expect, it } from 'vitest';
import { DT } from '../src/config';
import { projectOnTrack } from '../src/track';
import { cruise, inp, lc, lcCarSuite } from './lc-car';
import { session } from './harness';

lcCarSuite('lcf1');

describe('lcf1', () => {
  it('opens its flaps on the start straight at full throttle and closes them on the brakes', async () => {
    const { car, drive } = await session('lcf1');
    const v = lc(car).vehicle;
    drive(8, (c) => inp({ throttle: cruise(c, 40, 0.7) }), () => car.speedF > 38);
    expect(v.drsOpen).toBe(false);                    // not below full throttle
    drive(1, () => inp({ throttle: 1 }), () => v.drsOpen);
    expect(v.drsOpen).toBe(true);
    drive(0.05, () => inp({ brake: 0.3 }));
    expect(v.drsOpen).toBe(false);
    // ...and open again when the brake is let go, even if the throttle never lifted (the engine refuses a request
    // made on the brake, and only looks at a new one)
    drive(0.1, () => inp({ throttle: 1, brake: 0.2 }));
    expect(v.drsOpen).toBe(false);
    drive(0.5, () => inp({ throttle: 1 }), () => v.drsOpen);
    expect(v.drsOpen).toBe(true);
  });

  it('resets its lap energy allowance as it crosses the line', async () => {
    const { car, track, drive } = await session('lcf1');
    const v = lc(car).vehicle;
    car.placeAt(track.L - 370);                       // the start of the straight, to be past 100 km/h well before the line
    // The engine wraps its lap at the centre of mass during a tick; proj is where the tick started
    let before = 0, after = -1, at = NaN;
    drive(15, (c) => inp({ throttle: cruise(c, 60, c.speedF < 20 ? 0.6 : 0.8) }), () => {
      if (v.lapDeployJ >= before) { before = v.lapDeployJ; return false; }
      const p = projectOnTrack(track, car.pos.x, car.pos.z, -1, { i: 0, s: 0, lat: 0 });
      after = v.lapDeployJ; at = Math.min(p.s, track.L - p.s);
      return true;
    });
    expect(before).toBeGreaterThan(300e3);            // deployed on the way to the line
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThan(10e3);                 // and starting again from nothing after it
    expect(at).toBeLessThan(car.speedF * DT + 0.1);   // within the tick that crossed the line
  });
});
