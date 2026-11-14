import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Car, DriveInput } from '../src/car';
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

// Where the rear axle is going relative to where the car points (degrees): the size of a slide.
const rearSlide = (c: Car) => Math.atan2(c.vel.dot(c.left) + c.angv.dot(c.up) * c.spec.zRear, Math.max(Math.abs(c.speedF), 3)) * 180 / Math.PI;

describe('drift car', () => {
  it('stops from 100 km/h in about 29 m, in a straight line', async () => {
    const { car, drive } = await session('drift');
    car.forceSurface = S_ASPHALT;
    const pedals = (throttle: number, brake: number): DriveInput => ({ throttle, brake, steer: 0, analog: true, steerAngle: 0, autoGears: true });
    drive(10, () => pedals(1, 0), () => car.speedF >= 100 / 3.6);
    const yaw = () => Math.atan2(car.fwd.x, car.fwd.z) * 180 / Math.PI;
    const from = car.pos.clone(), heading = yaw();
    drive(5, () => pedals(0, 1), () => car.speedF < 0.3);
    const dist = car.pos.distanceTo(from);
    expect(dist).toBeGreaterThan(25);
    expect(dist).toBeLessThan(32);                    // 38 m before the tyres' braking grip was raised
    expect(Math.abs(yaw() - heading)).toBeLessThan(0.5);
  });

  // Kick the tail out with brake + steering keys at 90 km/h; once the rear is 20 deg out, lift off, do what `after`
  // says with the steering keys for 3 s, and report how the slide ends.
  async function slide(after: (slideDeg: number) => number, { assist = false } = {}) {
    const { car, drive } = await session('drift', { walls: false });
    car.forceSurface = S_ASPHALT;
    car.assist = assist;
    let upToSpeed = false, t0: number | null = null, now = 0, max = 0, wheel = 0;
    drive(12, (c, t) => {
      now = t;
      upToSpeed ||= c.speedF >= 25;
      if (!upToSpeed) return { throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };
      if (t0 == null) {
        if (Math.abs(rearSlide(c)) < 20) return { throttle: 0, brake: 1, steer: 1, analog: false, autoGears: true };
        t0 = t;
      }
      max = Math.max(max, Math.abs(rearSlide(c)));
      if (t - t0 < 0.3) wheel = c.steer;
      return { throttle: 0, brake: 0, steer: after(rearSlide(c)), analog: false, autoGears: true };
    }, () => t0 != null && now - t0 > 3);
    expect(t0).not.toBeNull();
    return { max, end: Math.abs(rearSlide(car)), yaw: Math.abs(car.angv.y), wheel, speed: car.speedF };
  }

  // Hold the left key from `kmh` with the given pedals for 4 s (stopping early past 80 deg): how far the tail goes.
  async function holdKey(kmh: number, throttle: number, { tc = true, assist = false } = {}) {
    const { car, drive } = await session('drift', { tc, walls: false });
    car.forceSurface = S_ASPHALT;
    car.assist = assist;
    let upToSpeed = false, t0 = -1, now = 0, max = 0, at20 = -1;
    drive(12, (c, t) => {
      now = t;
      upToSpeed ||= c.speedF >= kmh / 3.6;
      if (!upToSpeed) return { throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };
      if (t0 < 0) t0 = t;
      max = Math.max(max, Math.abs(rearSlide(c)));
      if (at20 < 0 && max > 20) at20 = t - t0;
      return { throttle, brake: 0, steer: 1, analog: false, autoGears: true };
    }, () => t0 >= 0 && (now - t0 > 4 || Math.abs(rearSlide(car)) > 80));
    return { max, at20, end: Math.abs(rearSlide(car)), wheel: car.steer, speed: car.speedF };
  }

  it('steering alone does not spin it: off the throttle, a held key stays under 20 deg of slide', async () => {
    expect((await holdKey(90, 0)).max).toBeLessThan(20);
    expect((await holdKey(65, 0)).max).toBeLessThan(20);
  });

  it('the throttle steps the tail out: past 20 deg within 1.5 s with TC off, and it keeps going if held', async () => {
    const r = await holdKey(65, 1, { tc: false });
    expect(r.at20).toBeGreaterThan(0.3);              // builds, rather than snapping
    expect(r.at20).toBeLessThan(1.5);
    expect(r.max).toBeGreaterThan(60);
  });

  it('a slide is caught by lifting off and steering into it', async () => {
    const r = await slide((deg) => (Math.abs(deg) > 9 ? Math.sign(deg) : 0));   // keys: opposite lock while it slides
    expect(r.max).toBeLessThan(35);
    expect(r.end).toBeLessThan(8);
    expect(r.speed).toBeGreaterThan(5);               // still rolling forwards, not spun
  });

  it('a keyboard driver can hold a power slide by feathering the throttle', async () => {
    const { car, drive } = await session('drift', { tc: false, walls: false });
    car.forceSurface = S_ASPHALT;
    let upToSpeed = false, t0 = -1, now = 0, max = 0, sliding = 0, n = 0;
    drive(14, (c, t) => {
      now = t;
      upToSpeed ||= c.speedF >= 18;
      if (!upToSpeed) return { throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };
      if (t0 < 0) t0 = t;
      const out = -rearSlide(c);                      // tail out, in a left turn
      max = Math.max(max, Math.abs(out));
      if (t - t0 > 1) { n++; if (out > 10 && out < 45) sliding++; }
      // turn in until it slides, then opposite lock; throttle on below 28 deg, off above
      return { throttle: out < 28 ? 1 : 0, brake: 0, steer: out < 8 ? 1 : out > 14 ? -1 : 0, analog: false, autoGears: true };
    }, () => t0 >= 0 && now - t0 > 6);
    expect(max).toBeLessThan(60);
    expect(sliding / n).toBeGreaterThan(0.3);         // sideways (10-45 deg) for a good part of the 5 s
    expect(car.speedF).toBeGreaterThan(10);
  });

  describe('with the countersteer assist on', () => {
    it('a slide straightens out when the driver lets go of the steering', async () => {
      const r = await slide(() => 0, { assist: true });
      expect(r.wheel).toBeLessThan(-0.05);            // slid with the tail out to the right: the wheels turned right
      expect(r.max).toBeLessThan(35);
      expect(r.end).toBeLessThan(4);
      expect(r.yaw).toBeLessThan(0.2);
      expect(r.speed).toBeGreaterThan(5);
    });

    it('holding the steering key on the power settles into a slide on opposite lock, not a spin', async () => {
      const r = await holdKey(65, 1, { tc: false, assist: true });
      expect(r.max).toBeLessThan(45);
      expect(r.end).toBeGreaterThan(15);              // still sliding after 4 s...
      expect(r.wheel).toBeLessThan(-0.15);            // ...with the wheels turned the other way
      expect(r.speed).toBeGreaterThan(15);
    });
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
