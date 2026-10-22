import { describe, expect, it } from 'vitest';
import type { DriveInput } from '../src/car';
import type { CarId } from '../src/cars';
import { S_ASPHALT } from '../src/config';
import { session } from './harness';

// Accelerate down the start straight to v0 (m/s), then hold `input` for 1.2 s.
// Returns the largest slip angle (degrees between heading and direction of travel) during that time.
async function maxSlipAngle(carId: CarId, v0: number, input: Pick<DriveInput, 'brake' | 'steer'>) {
  const { car, drive } = await session(carId);
  car.forceSurface = S_ASPHALT;                 // the manoeuvre can run past the track edge
  let t0: number | null = null, maxDeg = 0;
  drive(8, (c, t) => {
    if (t0 == null) {
      if (c.speedF > v0) t0 = t;
      return { throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };
    }
    if (t - t0 < 1.2) {
      const slip = Math.atan2(Math.abs(c.vel.dot(c.left)), Math.max(Math.abs(c.speedF), 0.5)) * 180 / Math.PI;
      if (c.speedF > 3) maxDeg = Math.max(maxDeg, slip);
      return { throttle: 0, analog: true, autoGears: true, ...input };
    }
    return { throttle: 0, brake: 0.5, steer: 0, analog: true, autoGears: true };
  });
  return maxDeg;
}

describe('handling', () => {
  it('drift car: braking while turning kicks the tail out; braking straight stays straight', async () => {
    expect(await maxSlipAngle('drift', 22, { brake: 0.5, steer: 0.4 })).toBeGreaterThan(15);
    expect(await maxSlipAngle('drift', 30, { brake: 1, steer: 0 })).toBeLessThan(1);
  });

  it('F1 stays planted when braking while turning', async () => {
    expect(await maxSlipAngle('f1', 22, { brake: 0.5, steer: 0.4 })).toBeLessThan(6);
  });
});
