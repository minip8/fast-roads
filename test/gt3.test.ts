// The GT3 against the car it is taken from. LibreCorsa (github.com/KhazP/librecorsa) publishes what its Mercedes-AMG
// GT3 does in its own simulation, next to the real car's telemetry it is fitted to (docs/physics/README.md there):
// sustained cornering g, braking g and full-throttle g by speed, and the understeer gradient. The same manoeuvres are
// run here, on flat asphalt with no walls, and must land on LibreCorsa's numbers.
import { describe, expect, it } from 'vitest';
import type { Car, DriveInput } from '../src/car';
import { CARS } from '../src/cars';
import { DT, S_ASPHALT } from '../src/config';
import { session } from './harness';

// [km/h, LibreCorsa's simulator, the real car (MoTeC logs)]
const LATERAL_G = [[81, 1.71, 1.70], [99, 1.75, 1.79], [117, 1.80, 1.79], [153, 1.92, 2.13], [171, 1.98, 2.01]];
const BRAKING_G = [[99, 1.66, 1.68], [117, 1.77, 1.72], [153, 1.95, 1.83], [189, 2.11, 2.03], [225, 2.17, 2.11], [243, 2.18, 2.12]];
const THROTTLE_G = [[63, 0.85, 0.95], [99, 0.83, 0.77], [135, 0.60, 0.64], [171, 0.43, 0.45], [207, 0.31, 0.30], [243, 0.20, 0.19]];
const UNDERSTEER_DEG_PER_G = 1.42;                     // road-wheel angle per g beyond the geometric one; real car 1.44
const RPM_PER_MS = [[2, 181.2], [3, 141.3], [4, 115.3], [5, 100.8]];

const spec = CARS.gt3, G = 9.81, DEG = 180 / Math.PI;

// The car on open asphalt, already moving at v0 (m/s).
async function rolling(v0: number) {
  const s = await session('gt3', { walls: false });
  const { car } = s;
  car.forceSurface = S_ASPHALT;
  car.body.setLinvel({ x: car.fwd.x * v0, y: 0, z: car.fwd.z * v0 }, true);
  return s;
}
const input = (throttle: number, brake: number, steerAngle: number): DriveInput => ({ throttle, brake, steer: 0, analog: true, steerAngle, autoGears: true });

// Sustained cornering at a held speed: the wheels are turned slowly (over `secs`) until the car is well past its
// limit. Returns the best 1 s average of lateral g, and the road-wheel angle per g (deg) between 0.2 and 1 g.
async function cornering(kmh: number, secs = 14) {
  const v = kmh / 3.6, { car, drive } = await rolling(v);
  const full = 0.9 * spec.steerLock * Math.min(1, 1.6 * (81 / kmh) ** 2);   // enough lock for the limit at this speed
  const window: number[] = [], pts: [number, number][] = [];
  let pedal = 0.3, best = 0, steer = 0, prev = car.vel.clone(), sum = 0;
  drive(secs, (c: Car, t) => {
    pedal = Math.max(0, Math.min(1, pedal + (c.vel.length() < v ? 0.02 : -0.02)));
    steer = Math.min(1, t / secs) * full;
    return input(pedal, 0, steer);
  }, () => {
    const ay = Math.abs(car.vel.clone().sub(prev).dot(car.left)) / DT / G;
    prev = car.vel.clone();
    window.push(ay); sum += ay;
    if (window.length > 120) sum -= window.shift()!;
    if (window.length === 120) best = Math.max(best, sum / 120);
    if (ay > 0.2 && ay < 1 && window.length === 120) pts.push([ay, steer * DEG]);
    return Math.abs(Math.atan2(car.vel.dot(car.left), car.speedF)) > 0.35;   // spun or ploughing: far past the limit
  });
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const degPerG = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return { g: best, degPerG };
}

// Mean g while the speed passes from 1.5 m/s on one side of `kmh` to 1.5 m/s on the other, pedal flat.
async function straightLine(kmh: number, pedal: 'throttle' | 'brake') {
  const v = kmh / 3.6, braking = pedal === 'brake', { car, drive } = await rolling(braking ? v + 8 : Math.max(8, v - 12));
  const from = braking ? v + 1.5 : v - 1.5, to = braking ? v - 1.5 : v + 1.5, past = (at: number) => (braking ? car.speedF <= at : car.speedF >= at);
  let t0 = -1, t1 = -1, now = 0, was = car.speedF;
  // the moment the speed passed `at`, within the last tick
  const crossed = (at: number) => now + DT * (at - was) / (car.speedF - was);
  drive(30, (_c, t) => { now = t; was = car.speedF; return input(braking ? 0 : 1, braking ? 1 : 0, 0); }, () => {
    if (t0 < 0 && past(from)) t0 = crossed(from);
    if (t1 < 0 && past(to)) t1 = crossed(to);
    return t1 >= 0;
  });
  return 3 / (t1 - t0) / G;
}

const within = (ours: number, theirs: number, share: number) => {
  expect(ours).toBeGreaterThan(theirs * (1 - share));
  expect(ours).toBeLessThan(theirs * (1 + share));
};

describe('GT3 against LibreCorsa', () => {
  it('corners as hard at every speed, and needs as much more lock per g (understeer)', async () => {
    const runs = [];
    for (const [kmh, sim] of LATERAL_G) {
      const r = await cornering(kmh);
      within(r.g, sim, 0.03);                         // within 1.5% when this was written
      runs.push({ invV2: 1 / (kmh / 3.6) ** 2, degPerG: r.degPerG });
    }
    // Lock per g = 57.3 L g / v^2 + K: the slope against 1/v^2 is the wheelbase, the intercept K the understeer gradient.
    const n = runs.length, mx = runs.reduce((a, r) => a + r.invV2, 0) / n, my = runs.reduce((a, r) => a + r.degPerG, 0) / n;
    const slope = runs.reduce((a, r) => a + (r.invV2 - mx) * (r.degPerG - my), 0) / runs.reduce((a, r) => a + (r.invV2 - mx) ** 2, 0);
    within(slope / DEG / G, spec.zFront - spec.zRear, 0.1);
    expect(Math.abs(my - slope * mx - UNDERSTEER_DEG_PER_G)).toBeLessThan(0.15);
  });

  // Loosest at the ends. At 99 km/h this car brakes 6% harder: its ABS keeps each tyre at its own limit, where
  // LibreCorsa's test eases one pedal for all four.
  it('brakes as hard at every speed', async () => {
    for (const [kmh, sim] of BRAKING_G) within(await straightLine(kmh, 'brake'), sim, 0.08);
  });

  it('accelerates as hard at every speed, through the same gearing', async () => {
    for (const [kmh, sim] of THROTTLE_G) within(await straightLine(kmh, 'throttle'), sim, 0.07);
    for (const [gear, rpmPerMs] of RPM_PER_MS) within(spec.redline / spec.gearTop[gear], rpmPerMs, 0.005);
  });
});

// What a player meets: a planted car that runs out of front grip first. `steer` and the pedals are held from `kmh`
// for `secs`; returns the largest rear slide (deg) and the cornering g over the last half second.
describe('GT3 on the keyboard', () => {
  async function hold(kmh: number, keys: Partial<DriveInput>, secs: number, { tc = true, coast = 0 } = {}) {
    const { car, drive } = await rolling(kmh / 3.6);
    car.tc = tc;
    const gs: number[] = [];
    let slide = 0, prev = car.vel.clone();
    // `coast` seconds on the steering alone first, so the car is already cornering when the pedals go down
    drive(coast + secs, (_c, t) => ({ throttle: 0, brake: 0, steer: 0, analog: false, autoGears: true, ...(t < coast ? { steer: keys.steer } : keys) }), () => {
      gs.push(Math.abs(car.vel.clone().sub(prev).dot(car.left)) / DT / G);
      prev = car.vel.clone();
      slide = Math.max(slide, Math.abs(Math.atan2(car.vel.dot(car.left) + car.angv.dot(car.up) * spec.zRear, Math.max(Math.abs(car.speedF), 3))) * DEG);
      return false;
    });
    return { slide, g: gs.slice(-60).reduce((a, b) => a + b, 0) / 60, kmh: car.speedF * 3.6 };
  }

  it('a held steering key corners near the limit at any speed without the tail coming round', async () => {
    for (const [kmh, atLeast] of [[60, 1.3], [100, 1.6], [150, 1.75], [200, 1.9], [250, 2.0]]) {
      const r = await hold(kmh, { steer: 1 }, 3);
      expect(r.g).toBeGreaterThan(atLeast);
      expect(r.slide).toBeLessThan(7);
    }
  });

  it('stays planted braking into a corner', async () => {
    for (const kmh of [100, 150, 200, 250]) expect((await hold(kmh, { steer: 1, brake: 1 }, 2.5)).slide).toBeLessThan(9);
  });

  it('full throttle from the middle of a corner drives it out, with traction control or without', async () => {
    for (const tc of [true, false]) for (const kmh of [50, 70, 100, 140]) {
      const r = await hold(kmh, { steer: 1, throttle: 1 }, 3, { tc, coast: 1.5 });
      expect(r.slide).toBeLessThan(5);
      expect(r.kmh).toBeGreaterThan(kmh + 20);
    }
  });
});
