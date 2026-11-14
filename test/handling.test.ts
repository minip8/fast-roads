import * as THREE from 'three';
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
  let t0: number | null = null, maxDeg = 0, done = false;
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
    done = true;
    return { throttle: 0, brake: 0.5, steer: 0, analog: true, autoGears: true };
  }, () => done);
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

describe('reverse', () => {
  for (const id of ['f1', 'drift'] as const) {
    it(`${id}: reverse tops out at reverseTop, and the throttle stops it`, async () => {
      const { car, drive } = await session(id);
      car.forceSurface = S_ASPHALT;
      const pedals = (throttle: number, brake: number): DriveInput => ({ throttle, brake, steer: 0, analog: true, steerAngle: 0, autoGears: true });
      drive(6, () => pedals(0, 1));                  // hold brake: stops, engages reverse, backs up
      expect(car.gear).toBe(0);
      expect(-car.speedF).toBeGreaterThan(0.7 * car.spec.reverseTop);
      expect(-car.speedF).toBeLessThan(car.spec.reverseTop);
      const v0 = -car.speedF;
      drive(1, () => pedals(0, 0));                  // coasting backwards: engine braking slows it
      expect(-car.speedF).toBeLessThan(v0 - 0.2);
      drive(1.5, () => pedals(1, 0));                // throttle brakes, then drives forwards
      expect(car.gear).toBeGreaterThan(0);
      expect(car.speedF).toBeGreaterThan(0);
    });
  }
});

it('a car left on its side is put back on its wheels', async () => {
  const { car, drive } = await session('drift');   // the drift car's boxy body rests on its side; the F1 tips back
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  car.body.setRotation(car.quat.clone().multiply(roll), true);
  car.body.setTranslation({ x: car.pos.x, y: car.spec.hull[0] + 0.05, z: car.pos.z }, true);
  car.readState();
  drive(1, () => ({ throttle: 0, brake: 0, steer: 0, analog: false }));
  expect(Math.abs(car.up.y)).toBeLessThan(0.1);      // settled on its side; no instant reset
  drive(1.5, () => ({ throttle: 0, brake: 0, steer: 0, analog: false }));
  expect(car.up.y).toBeGreaterThan(0.99);
});

it('non-finite drive input is ignored instead of breaking the physics', async () => {
  const { car, drive } = await session('f1');
  car.forceSurface = S_ASPHALT;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  drive(1, () => ({ throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true }));
  const v0 = car.speedF;
  drive(0.2, () => ({ throttle: NaN, brake: Infinity, steer: NaN, analog: true, steerAngle: NaN }));
  drive(0.5, () => ({ throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true }));
  expect([car.pos.x, car.pos.y, car.pos.z, car.speedF].every(Number.isFinite)).toBe(true);
  expect(car.speedF).toBeGreaterThan(v0);           // still drives afterwards
  vi.restoreAllMocks();
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

  it('mouse: the wheel is proportional to the cursor distance past the dead zone', () => {
    vi.stubGlobal('addEventListener', () => {});
    vi.stubGlobal('innerWidth', 2000);
    const input = new Input(), m = input.mouse;
    m.range = 0.7; m.deadzone = 0.1;   // full lock 700 px from the centre, nothing within 100 px
    const steerAt = (x: number) => { m.x = x; return input.mouseSteer(); };
    expect(steerAt(1000)).toBeCloseTo(0);
    expect(steerAt(1090)).toBeCloseTo(0);        // inside the dead zone
    expect(steerAt(1250)).toBeCloseTo(-0.25);    // cursor right = steer right
    expect(steerAt(1400)).toBeCloseTo(-0.5);
    expect(steerAt(600)).toBeCloseTo(0.5);
    expect(steerAt(1900)).toBeCloseTo(-1);       // past the range: full lock
  });
});
