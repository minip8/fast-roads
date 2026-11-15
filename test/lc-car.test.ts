// The GT3 on LibreCorsa's engine in the game's session (the suite is in lc-car.ts; the F1 has lc-car-f1.test.ts).
import { describe, expect, it } from 'vitest';
import { cruise, inp, lc, lcCarSuite } from './lc-car';
import { session } from './harness';

lcCarSuite('lcgt3');

describe('lcgt3', () => {
  it('has no flaps', async () => {
    const { car, drive } = await session('lcgt3');
    drive(4, (c) => inp({ throttle: cruise(c, 40, 0.8) }));
    expect(lc(car).vehicle.drsOpen).toBe(false);
    expect(lc(car).vehicle.telemetry.drsAvailable).toBe(false);
  });
});
