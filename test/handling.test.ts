import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DriveInput } from '../src/car';
import type { CarId } from '../src/cars';
import { DT, S_ASPHALT } from '../src/config';
import { Input } from '../src/input';
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

describe('input', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('gamepad: triggers with the stick in its dead zone steer straight (not NaN)', async () => {
    vi.stubGlobal('addEventListener', () => {});
    const pad = { axes: [0], buttons: Array.from({ length: 10 }, (_, i) => ({ pressed: false, value: i === 7 ? 1 : 0 })) };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const input = new Input();
    for (const ax of [0, 0.03, -0.05]) {
      pad.axes[0] = ax;
      expect(input.poll(DT)).toMatchObject({ steer: 0, throttle: 1, analog: true });
    }
    pad.axes[0] = -1; expect(input.poll(DT).steer).toBeCloseTo(1);   // stick left = steer left, full range
    pad.axes[0] = 0.54; expect(input.poll(DT).steer).toBeCloseTo(-Math.pow(0.5, 1.4));
  });
});
