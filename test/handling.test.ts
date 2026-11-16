import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CarId } from '../src/cars';
import { DT, S_ASPHALT } from '../src/config';
import { Input } from '../src/input';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { ourCar, session } from './harness';

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
const rearSlide = (c: Vehicle) => Math.atan2(c.vel.dot(c.left) + c.angv.dot(c.up) * c.spec.zRear, Math.max(Math.abs(c.speedF), 3)) * 180 / Math.PI;

describe('drift car', () => {
  const straight: DriveInput = { throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };

  it('stops from 100 km/h in about 29 m, in a straight line', async () => {
    const { car, drive } = await session('drift');
    car.forceSurface = S_ASPHALT;
    drive(10, () => straight, () => car.speedF >= 100 / 3.6);
    const yaw = () => Math.atan2(car.fwd.x, car.fwd.z) * 180 / Math.PI;
    const from = car.pos.clone(), heading = yaw();
    drive(5, () => ({ ...straight, throttle: 0, brake: 1 }), () => car.speedF < 0.3);
    const dist = car.pos.distanceTo(from);
    expect(dist).toBeGreaterThan(25);
    expect(dist).toBeLessThan(32);                    // 38 m before the tyres' braking grip was raised
    expect(Math.abs(yaw() - heading)).toBeLessThan(0.5);
  });

  it('reaches 100 km/h in about 3 s', async () => {
    const { car, drive } = await session('drift');
    car.forceSurface = S_ASPHALT;
    let t = 0;
    drive(10, (_c, now) => { t = now; return straight; }, () => car.speedF >= 100 / 3.6);
    expect(t).toBeGreaterThan(2.5);
    expect(t).toBeLessThan(3.3);                      // 5.7 s originally: lighter, and the loose rear no longer costs traction
  });

  // --- Driven with the mouse: steering is a position (-1..1, + = left) that the hand moves at up to 5 units/s, the
  // throttle is a button. From 90 km/h, `plan` says where the mouse and the throttle should be; the log records
  // the slide (deg the tail is out in a left turn), speed (m/s) and how far the direction of travel has turned.
  interface Log { out: number[]; v: number[]; course: number; spun: boolean }
  const at = (arr: number[], secs: number) => arr[Math.min(arr.length - 1, Math.round(secs / DT))];
  const peakRate = (arr: number[], from = 0) => {     // fastest change over any 0.1 s (per second)
    let p = 0;
    for (let i = Math.max(12, Math.round(from / DT)); i < arr.length; i++) p = Math.max(p, Math.abs(arr[i] - arr[i - 12]) / 0.1);
    return p;
  };
  const spread = (arr: number[], from: number) => {
    const a = arr.slice(Math.round(from / DT)), mean = a.reduce((x, y) => x + y, 0) / a.length;
    return { mean, sd: Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length) };
  };
  async function mouse(secs: number, plan: (t: number, log: Log) => { m: number; throttle: number }, { tc = true } = {}) {
    const { car, drive } = await session('drift', { tc, walls: false });
    car.forceSurface = S_ASPHALT;
    const log: Log = { out: [], v: [], course: 0, spun: false };
    let upToSpeed = false, t0 = -1, now = 0, m = 0, heading: number | null = null;
    drive(30, (c, t) => {
      now = t;
      upToSpeed ||= c.speedF >= 25;
      if (!upToSpeed) return straight;
      if (t0 < 0) t0 = t;
      const want = plan(t - t0, log);
      m += Math.max(-5 * DT, Math.min(5 * DT, want.m - m));
      const out = -rearSlide(c), dir = Math.atan2(c.vel.x, c.vel.z);
      if (heading != null) log.course += Math.abs(Math.atan2(Math.sin(dir - heading), Math.cos(dir - heading))) * 180 / Math.PI;
      heading = dir;
      log.out.push(out); log.v.push(c.vel.length());
      if (Math.abs(out) > 100 || c.speedF < -1) log.spun = true;
      return { throttle: want.throttle, brake: 0, steer: m, analog: true, autoGears: true };
    }, () => t0 >= 0 && (now - t0 > secs || log.spun));
    return log;
  }
  // A driver holding the slide near `target(t)` deg, reacting 0.2 s late to the angle and how fast it is changing.
  const holding = (target: (t: number) => number) => (t: number, log: Log) => {
    const k = Math.max(0, log.out.length - 1 - Math.round(0.2 / DT)), seen = log.out[k] ?? 0, rate = (seen - (log.out[Math.max(0, k - 12)] ?? 0)) / 0.1;
    const want = target(t);
    return { m: Math.max(-1, Math.min(1, Math.sign(want) * 0.45 - (seen - want) / 30 - rate * 0.004)), throttle: 1 };
  };

  it('turning in on the throttle swings the tail out progressively: 20 deg in about a second, never a snap', async () => {
    const log = await mouse(3.5, () => ({ m: 0.5, throttle: 1 }));
    const past20 = log.out.findIndex((o) => o > 20) * DT;
    expect(past20).toBeGreaterThan(0.6);
    expect(past20).toBeLessThan(1.6);
    expect(Math.max(...log.out)).toBeLessThan(50);
    expect(peakRate(log.out)).toBeLessThan(45);       // deg/s
    expect(log.spun).toBe(false);
  });

  it('moderate steering off the throttle rotates the car without a big slide', async () => {
    const log = await mouse(2, () => ({ m: 0.3, throttle: 0 }));
    expect(at(log.out, 1.5)).toBeGreaterThan(8);
    expect(at(log.out, 1.5)).toBeLessThan(32);        // it used to be 41 deg out here
  });

  it('a slide holds steadily for as long as the throttle is down, keeps its speed, and follows its nose', async () => {
    for (const pos of [0, -0.25]) {                   // wheel straight, or a little opposite lock
      const log = await mouse(7, (t) => (t < 1.5 ? { m: 0.5, throttle: 1 } : { m: pos, throttle: 1 }));
      const slide = spread(log.out, 4);
      expect(slide.mean).toBeGreaterThan(22);
      expect(slide.mean).toBeLessThan(38);
      expect(slide.sd).toBeLessThan(6);
      expect(at(log.v, 7) * 3.6).toBeGreaterThan(70);  // entered at 90 km/h; it used to bog down to about 30
      expect(at(log.v, 7) * 3.6).toBeLessThan(120);
      expect(log.course / 7).toBeGreaterThan(18);     // deg/s the direction of travel turns
      expect(log.spun).toBe(false);
    }
  });

  it('lifting off and centring the mouse straightens the car in about a second, without swinging back', async () => {
    const log = await mouse(5, (t) => (t < 1.6 ? { m: 0.5, throttle: 1 } : { m: 0, throttle: 0 }));
    const after = log.out.slice(Math.round(1.6 / DT)), back = after.findIndex((o) => Math.abs(o) < 8) * DT;
    expect(at(log.out, 1.6)).toBeGreaterThan(25);
    expect(back).toBeGreaterThan(0.6);
    expect(back).toBeLessThan(2.2);
    expect(Math.min(...after)).toBeGreaterThan(-8);   // no swing the other way
  });

  it('switching from a left slide to a right one does not whip the tail round', async () => {
    const log = await mouse(7.5, holding((t) => (t < 3 ? 25 : -25)));
    const after = log.out.slice(Math.round(3 / DT)), settled = spread(log.out, 5);
    expect(log.spun).toBe(false);
    expect(Math.min(...after)).toBeGreaterThan(-52);  // it used to swing to 70-80 deg and spin
    expect(peakRate(log.out, 3)).toBeLessThan(115);   // deg/s
    expect(settled.mean).toBeLessThan(-18);           // and settles into the new slide
    expect(settled.mean).toBeGreaterThan(-42);
    expect(settled.sd).toBeLessThan(12);
  });

  // --- Driven with the keys: full lock or nothing.
  // Kick the tail out with brake + steering keys at 90 km/h; once the rear is `from` deg out, lift off, do what
  // `after` says with the steering keys for 4 s, and report how the slide ends.
  async function slide(after: (slideDeg: number) => number, { assist = false, from = 20 } = {}) {
    const { car, drive } = await session('drift', { walls: false });
    car.forceSurface = S_ASPHALT;
    car.assist = assist;
    let upToSpeed = false, t0: number | null = null, now = 0, max = 0, wheel = 0;
    drive(12, (c, t) => {
      now = t;
      upToSpeed ||= c.speedF >= 25;
      if (!upToSpeed) return straight;
      if (t0 == null) {
        if (Math.abs(rearSlide(c)) < from) return { throttle: 0, brake: 1, steer: 1, analog: false, autoGears: true };
        t0 = t;
      }
      max = Math.max(max, Math.abs(rearSlide(c)));
      if (t - t0 < 0.3) wheel = c.steer;
      return { throttle: 0, brake: 0, steer: after(rearSlide(c)), analog: false, autoGears: true };
    }, () => t0 != null && now - t0 > 4);
    expect(t0).not.toBeNull();
    return { max, end: Math.abs(rearSlide(car)), yaw: Math.abs(car.angv.y), wheel, speed: car.speedF };
  }

  // Hold the left key from `kmh` with the given throttle for 4 s (stopping early past 80 deg): how far the tail goes.
  async function holdKey(kmh: number, throttle: number, { tc = true, assist = false } = {}) {
    const { car, drive } = await session('drift', { tc, walls: false });
    car.forceSurface = S_ASPHALT;
    car.assist = assist;
    let upToSpeed = false, t0 = -1, now = 0, max = 0;
    drive(12, (c, t) => {
      now = t;
      upToSpeed ||= c.speedF >= kmh / 3.6;
      if (!upToSpeed) return straight;
      if (t0 < 0) t0 = t;
      max = Math.max(max, Math.abs(rearSlide(c)));
      return { throttle, brake: 0, steer: 1, analog: false, autoGears: true };
    }, () => t0 >= 0 && (now - t0 > 4 || Math.abs(rearSlide(car)) > 80));
    return { max, end: Math.abs(rearSlide(car)), wheel: car.steer, speed: car.speedF };
  }

  it('a held steering key slides the car but never spins it, off the throttle or on it', async () => {
    for (const kmh of [65, 90, 130]) {
      const coasting = await holdKey(kmh, 0);
      expect(coasting.max).toBeGreaterThan(10);
      expect(coasting.max).toBeLessThan(35);
      expect(coasting.speed).toBeGreaterThan(0);
    }
    const power = await holdKey(65, 1, { tc: false });
    expect(power.max).toBeGreaterThan(25);
    expect(power.max).toBeLessThan(55);
  });

  it('letting go of everything straightens a slide', async () => {
    const r = await slide(() => 0);
    expect(r.max).toBeLessThan(50);
    expect(r.end).toBeLessThan(6);
    expect(r.speed).toBeGreaterThan(2);               // still rolling forwards, not spun
  });

  it('lifting off and holding the opposite key catches a 30 deg slide', async () => {
    const r = await slide((deg) => (Math.abs(deg) > 9 ? Math.sign(deg) : 0), { from: 30 });
    expect(r.max).toBeLessThan(50);
    expect(r.end).toBeLessThan(8);
    expect(r.speed).toBeGreaterThan(2);
  });

  describe('with the countersteer assist on', () => {
    it('a slide straightens out when the driver lets go of the steering', async () => {
      const r = await slide(() => 0, { assist: true });
      expect(r.wheel).toBeLessThan(-0.05);            // slid with the tail out to the right: the wheels turned right
      expect(r.max).toBeLessThan(35);
      expect(r.end).toBeLessThan(4);
      expect(r.yaw).toBeLessThan(0.2);
      expect(r.speed).toBeGreaterThan(2);
    });

    it('holding the steering key on the power settles into a slide on opposite lock, not a spin', async () => {
      const r = await holdKey(65, 1, { tc: false, assist: true });
      expect(r.max).toBeLessThan(45);
      expect(r.end).toBeGreaterThan(12);              // still sliding after 4 s...
      expect(r.wheel).toBeLessThan(-0.05);            // ...with the wheels turned the other way
      expect(r.speed).toBeGreaterThan(15);
    });
  });
});

describe('manual gearbox', () => {
  for (const id of ['f1', 'drift', 'gt3'] as const) {
    it(`${id}: a downshift that would over-rev is refused at once; neutral is below first, reverse below neutral`, async () => {
      const { car, drive } = await session(id, { walls: false });
      car.forceSurface = S_ASPHALT;
      car.manual = true;
      const spec = ourCar(car).spec, limit = spec.gearTop[1] * spec.overRev / spec.redline;   // m/s: first gear's over-rev speed
      const pedals = (throttle: number, brake: number): DriveInput => ({ throttle, brake, steer: 0, analog: true, steerAngle: 0, autoGears: false });
      car.pendingShift = 1;
      drive(15, () => pedals(1, 0), () => car.speedF > limit * 1.05);
      expect(car.gear).toBe(2);
      car.pendingShift = -1;
      drive(DT, () => pedals(0.3, 0));
      expect([car.gear, car.shiftDenied, car.pendingShift]).toEqual([2, true, 0]);     // refused, and the press is gone
      car.shiftDenied = false;
      drive(5, () => pedals(0, 0.5), () => car.speedF < limit * 0.95);
      car.pendingShift = -1;
      drive(DT, () => pedals(0, 0.5));
      expect([car.gear, car.shiftDenied, car.pendingShift]).toEqual([1, false, 0]);

      car.pendingShift = -1;
      drive(DT, () => pedals(0, 0));
      expect(car.gear).toBe(0);                      // neutral, on the move
      const coasting = car.speedF;
      drive(1, () => pedals(1, 0));
      expect(car.speedF).toBeLessThan(coasting);     // no drive...
      expect(car.rpm).toBeGreaterThan(spec.redline * 0.9);   // ...and the engine revs free
      car.pendingShift = -1;
      drive(DT, () => pedals(0, 0));
      expect(car.gear).toBe(0);                      // no reverse on the move
      drive(10, () => pedals(0, 0.6), () => Math.abs(car.speedF) < 0.1);
      drive(1, () => pedals(0, 1));
      expect(car.gear).toBe(0);                      // the brake held in neutral does not select reverse
      car.pendingShift = -1;
      drive(DT, () => pedals(0, 0));
      expect(car.gear).toBe(-1);
      car.pendingShift = 2;
      drive(DT, () => pedals(0, 0));
      expect(car.gear).toBe(0);
      drive(DT, () => pedals(0, 0));
      expect(car.gear).toBe(1);
      car.pendingShift = -1;                         // the automatic box has no neutral
      drive(DT, () => pedals(0, 0));
      expect(car.gear).toBe(0);
      drive(DT, () => ({ ...pedals(0, 0), autoGears: true }));
      expect(car.gear).toBe(1);
    });
  }
});

describe('reverse', () => {
  for (const id of ['f1', 'drift', 'gt3'] as const) {
    it(`${id}: reverse tops out at reverseTop, and the throttle stops it`, async () => {
      const { car, drive } = await session(id);
      car.forceSurface = S_ASPHALT;
      const pedals = (throttle: number, brake: number): DriveInput => ({ throttle, brake, steer: 0, analog: true, steerAngle: 0, autoGears: true });
      drive(6, () => pedals(0, 1));                  // hold brake: stops, engages reverse, backs up
      expect(car.gear).toBe(-1);
      expect(-car.speedF).toBeGreaterThan(0.7 * ourCar(car).spec.reverseTop);
      expect(-car.speedF).toBeLessThan(ourCar(car).spec.reverseTop);
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
  const s = await session('drift'), car = ourCar(s.car), { drive } = s;   // the drift car's boxy body rests on its side; the F1 tips back
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
