// The drivers of the LibreCorsa-engine cars (src/lc/driver.ts) on the vendored engine on flat ground: ABS, traction
// control, keyboard and analog steering, the autopilot's direct angle, and reset. Each car has its own test file
// (lc-driver-*.test.ts), so Vitest runs them in parallel. LC_DRIVER_LOG=1 prints the measured numbers.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { F1_DRIVER, f1Driver, GT3_DRIVER, gt3Driver, type DriverCar } from '../src/lc/driver';
import type { EngineDriverFactory } from '../src/lc/engineDriver';
import type { CarPhysicsConfig } from '../src/lc/vendor/sim/f12026-car/F12026CarConfig';
import { LC26_TUNED_CONFIG } from '../src/lc/vendor/sim/f12026-car/Lc26Tune';
import { FlatGroundQuery } from '../src/lc/vendor/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lc/vendor/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../src/lc/vendor/sim/gt3/AmgGt3Config';
import type { DriveInput } from '../src/vehicle';

const DT = 1 / 120, H = VehiclePhysics.FIXED_DT, G = 9.81, DEG = 180 / Math.PI;
const log = (...a: unknown[]) => {
  if (process.env.LC_DRIVER_LOG) console.log(a.map((x) => JSON.stringify(x, (_k, n) => (typeof n === 'number' ? +n.toFixed(3) : n))).join(' '));
};
const r = (x: number, d = 3) => +x.toFixed(d);

interface CarCase {
  id: 'GT3' | 'F1'; config: CarPhysicsConfig; driver: EngineDriverFactory; spec: DriverCar; wheelbase: number;
  refSlip: number;   // lock slip ratio the braking reference holds: the GT3's ABS in their telemetry, the F1 tyre's peak
  // The car's limit at 80, 150 and 220 km/h: steady lateral g at the best constant analog steering position through
  // this driver (speed held, mean over 2.5-3.5 s), measured once with a sweep of rack positions 0.05..0.7 by 0.025
  limitG: [number, number, number];
  // The analog steering position (share of full lock) at that limit, at the same speeds: analog input goes to the
  // rack unscaled, so the tests steer to these rather than to full deflection (see driver.ts)
  peakAt: [number, number, number];
  tcFromKmh: number;   // where the TC starts working, plus a margin: the GT3's TC does nothing below 40 km/h
}
const CARS: CarCase[] = [
  { id: 'GT3', config: AMG_GT3_CONFIG, driver: gt3Driver, spec: GT3_DRIVER, wheelbase: 2.65, refSlip: 0.077, limitG: [1.68, 1.88, 2.18], peakAt: [0.41, 0.31, 0.29], tcFromKmh: 45 },
  { id: 'F1', config: LC26_TUNED_CONFIG, driver: f1Driver, spec: F1_DRIVER, wheelbase: 3.4, refSlip: 0.1, limitG: [2.03, 2.81, 3.95], peakAt: [0.53, 0.33, 0.27], tcFromKmh: 10 },
];
const SPEEDS = [80, 150, 220] as const;
const EXIT_KMH = 80;

// The adapter's loop: per 120 Hz game tick one frame(), then the 2 ms engine steps that tick covers (4 or 5).
// step(H) runs exactly one fixed step: step() adds H to an accumulator that reset() zeroes and runs whole FIXED_DT
// steps while it holds one, so 0 + H runs one and leaves exactly 0 (checked in the reset test).
function rig(c: CarCase, kmh = 0, withDriver = true) {
  const v = new VehiclePhysics({ ground: new FlatGroundQuery(0), config: c.config });
  v.reset(0, 0, 0, kmh / 3.6);
  let d = c.driver(v);
  d.reset();
  const out: VehicleInputs = { throttle: 0, brake: 0, steer: 0 };
  let frames = 0, steps = 0, oneStep = true;
  const tick = (input: DriveInput, tc = true) => {
    d.frame(DT, input, tc);
    const until = Math.floor(((++frames) * 500) / 120 + 1e-9);
    for (; steps < until; steps++) {
      d.inputs(H, out);
      v.step(H, out);
      oneStep &&= v.lastStepTimeS === H && v.unsteppedS === 0;
      d.afterStep(H);
    }
  };
  // No driver: the input straight to the engine (+ steer = left in, as DriveInput)
  const raw = (input: DriveInput) => v.step(DT, { throttle: input.throttle, brake: input.brake, steer: -input.steer });
  return { v, d, out, tick: withDriver ? tick : raw, oneStep: () => oneStep, reset: () => { v.reset(0, 0, 0, kmh / 3.6); d.reset(); frames = steps = 0; },
           newDriver: () => { d = c.driver(v); } };
}

const axes = (v: VehiclePhysics) => ({
  fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion),
  left: new THREE.Vector3(1, 0, 0).applyQuaternion(v.quaternion),
});
const bodySlip = (v: VehiclePhysics) => { const { fwd, left } = axes(v); return Math.atan2(v.velocity.dot(left), v.velocity.dot(fwd)); };
const heading = (v: VehiclePhysics) => { const { fwd } = axes(v); return Math.atan2(fwd.x, fwd.z); };
const yawRate = (v: VehiclePhysics) => v.angularVelocity.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(v.quaternion));   // + = left
const driven = (v: VehiclePhysics) => v.drivenWheels.map((i) => v.wheels[i].slipRatio);
const holdSpeed = (v: VehiclePhysics, kmh: number) => THREE.MathUtils.clamp(0.3 + 0.2 * (kmh - v.telemetry.speedKmh), 0, 1);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

// Full brake from 200 km/h to a stop: the deceleration 200 -> 100 km/h, the worst slip ratio once the pedal is down,
// and how far the car strayed from its line
function stop(c: CarCase, pedal: (v: VehiclePhysics, p: number) => number, withDriver = true) {
  const { v, tick } = rig(c, 200, withDriver);
  let p = 1, t = 0, t100 = NaN, minSlip = 0, prev = 200;
  for (; t < 10 && v.telemetry.speedKmh > 1; t += DT) {
    p = pedal(v, p);
    tick({ throttle: 0, brake: p, steer: 0, analog: false });
    const kmh = v.telemetry.speedKmh;
    if (t > 0.3 && kmh > 10) minSlip = Math.min(minSlip, ...v.wheels.map((w) => w.slipRatio));
    if (Number.isNaN(t100) && kmh <= 100) t100 = t + DT * ((prev - 100) / (prev - kmh) - 1);   // within the tick
    prev = kmh;
  }
  return { decelG: (100 / 3.6) / t100 / G, stopS: t, minSlip, x: Math.abs(v.position.x), yawDeg: Math.abs(heading(v)) * DEG };
}

export const driverTests = (id: CarCase['id']) => describe(`LibreCorsa driver: ${id}`, () => {
  const c = CARS.find((k) => k.id === id)!;
  it('ABS stops straight from 200 km/h without locking a wheel', () => {
    const abs = stop(c, () => 1);
    // The slip-holding reference (test/lc-gt3-reference.ts): a pedal that keeps the worst wheel near refSlip
    const ref = stop(c, (v, p) => THREE.MathUtils.clamp(p + (Math.min(...v.wheels.map((w) => w.slipRatio)) < -c.refSlip ? -0.08 : 0.04), 0.2, 1), false);
    const locked = stop(c, () => 1, false);
    log(c.id, 'ABS', { abs, ref, locked });
    expect(abs.minSlip).toBeGreaterThan(-0.25);
    expect(abs.x).toBeLessThan(0.5);
    expect(abs.yawDeg).toBeLessThan(2);
    expect(abs.decelG / ref.decelG).toBeGreaterThan(0.9);
    expect(abs.decelG / ref.decelG).toBeLessThan(1.2);
    expect(locked.minSlip).toBeLessThan(-0.5);   // the engine alone locks up: the bound above can fail
  });

  it('traction control holds wheelspin from rest and out of a corner', () => {
    // From rest, full throttle key: the worst driven slip past the TC's speed floor, and the car's heading
    const launch = (tc: boolean, withDriver = true) => {
      const { v, tick } = rig(c, 0, withDriver);
      let maxSlip = 0;
      for (let t = 0; t < 3; t += DT) {
        tick({ throttle: 1, brake: 0, steer: 0, analog: false }, tc);
        if (v.telemetry.speedKmh > c.tcFromKmh) maxSlip = Math.max(maxSlip, ...driven(v));
      }
      return { maxSlip, kmh: v.telemetry.speedKmh, yawDeg: Math.abs(heading(v)) * DEG };
    };
    // Mid-corner at 80 km/h on a held steering input (about 1.5 g), then full throttle for 2 s
    const exit = (tc: boolean, withDriver = true, analog = true) => {
      const { v, tick } = rig(c, EXIT_KMH, withDriver);
      const steer = analog ? 0.65 * c.peakAt[0] : 1;   // analog: two thirds of the way to the tyres' peak
      for (let t = 0; t < 1.5; t += DT) tick({ throttle: holdSpeed(v, EXIT_KMH), brake: 0, steer, analog }, tc);
      const g0 = v.telemetry.latG, slips: number[] = [];
      let maxBody = 0, minYaw = Infinity;
      for (let t = 0; t < 2; t += DT) {
        tick({ throttle: 1, brake: 0, steer, analog }, tc);
        slips.push(Math.max(...driven(v)));
        maxBody = Math.max(maxBody, Math.abs(bodySlip(v)));
        minYaw = Math.min(minYaw, yawRate(v));
      }
      // The upshift's clutch engagement spikes the slip for a few ticks: the 90th percentile is what the TC holds
      const p90 = [...slips].sort((a, b) => a - b)[Math.floor(0.9 * slips.length)];
      return { g0, maxSlip: Math.max(...slips), p90, bodyDeg: maxBody * DEG, minYaw, kmh: v.telemetry.speedKmh };
    };
    const lOn = launch(true), lOff = launch(false), lRaw = launch(false, false);
    const eOn = exit(true), eOff = exit(false), eRaw = exit(false, false), eKeys = exit(false, true, false);
    log(c.id, 'TC', { launch: { on: lOn, off: lOff, raw: lRaw }, exit: { on: eOn, off: eOff, raw: eRaw, keysOff: eKeys } });
    expect(lOn.maxSlip).toBeLessThan(0.2);
    expect(lOn.yawDeg).toBeLessThan(2);
    // Past 45 km/h a GT3 standing start does not spin its rears even without TC: only the F1's shows the TC working
    if (c.tcFromKmh < 45) expect(lRaw.maxSlip).toBeGreaterThan(lOn.maxSlip + 0.1);
    expect(eOn.p90).toBeLessThan(0.15);
    expect(eOn.bodyDeg).toBeLessThan(20);   // the F1 slides about 13 deg and gathers itself
    expect(eOn.minYaw).toBeGreaterThan(0);   // still turning left
    // TC off: the rears spin up (the F1 spins on a held analog input, slip help or not; the GT3 slides about 20 deg
    // with the help, and spins without it, as the bare engine shows)
    expect(eOff.p90).toBeGreaterThan(2 * eOn.p90);
    expect(eRaw.p90).toBeGreaterThan(2 * eOn.p90);
    // TC off on a held throttle key, steering on keys: the slip help and the keyboard assist keep it in hand
    expect(eKeys.bodyDeg).toBeLessThan(15);
    expect(eKeys.minYaw).toBeGreaterThan(0);
  });

  // Held steering at a speed: steady lateral g (mean of the last 0.75 s of 3), time to 90 % of it, overshoot, the
  // ripple, the worst body slip; then let go and see the car straighten
  const corner = (steer: number, analog: boolean, kmh: number) => {
    const { v, tick } = rig(c, kmh);
    for (let t = 0; t < 1; t += DT) tick({ throttle: holdSpeed(v, kmh), brake: 0, steer: 0, analog });   // into gear
    const lat: number[] = [];
    let maxBody = 0;
    for (let t = 0; t < 3; t += DT) {
      tick({ throttle: holdSpeed(v, kmh), brake: 0, steer, analog });
      lat.push(v.telemetry.latG);
      maxBody = Math.max(maxBody, Math.abs(bodySlip(v)));
    }
    const last = lat.slice(-90), steady = mean(last);
    const t90 = lat.findIndex((g) => Math.abs(g) >= 0.9 * Math.abs(steady)) * DT;
    const peak = Math.max(...lat.map((g) => g * Math.sign(steady)));
    const kmhEnd = v.telemetry.speedKmh;
    for (let t = 0; t < 1; t += DT) tick({ throttle: holdSpeed(v, kmh), brake: 0, steer: 0, analog });
    const yawAfter = Math.abs(yawRate(v));
    const h0 = heading(v);
    for (let t = 0; t < 0.5; t += DT) tick({ throttle: holdSpeed(v, kmh), brake: 0, steer: 0, analog });
    return { steady, t90, overshoot: peak / Math.abs(steady), ripple: std(last), bodyDeg: maxBody * DEG, kmhEnd, yawAfter,
             drift: Math.abs(heading(v) - h0) * DEG };
  };

  it('keys: a held key corners near the limit, straightens when let go, both ways alike', () => {
    SPEEDS.forEach((kmh, i) => {
      const L = corner(1, false, kmh), R = corner(-1, false, kmh);
      log(c.id, 'keys', kmh, { L, R, share: r(L.steady / c.limitG[i]) });
      expect(L.steady).toBeGreaterThan(0.85 * c.limitG[i]);   // + = left
      expect(L.steady).toBeLessThan(1.05 * c.limitG[i]);
      expect(L.bodyDeg).toBeLessThan(8);
      expect(L.overshoot).toBeLessThan(1.15);
      // The engine itself ripples about 4 Hz in steady cornering, more turning right (a constant rack shows it too)
      expect(L.ripple / L.steady).toBeLessThan(0.05);
      expect(-R.ripple / R.steady).toBeLessThan(0.05);
      expect(L.yawAfter).toBeLessThan(0.03);
      expect(L.drift).toBeLessThan(0.5);
      expect(R.steady).toBeLessThan(0);
      expect(Math.abs(R.steady + L.steady)).toBeLessThan(0.02 * L.steady);
      expect(Math.abs(R.t90 - L.t90)).toBeLessThan(0.04);
    });
  });

  it('analog: the position at the tyres\' peak corners at the limit, half of it clearly less', () => {
    const res = SPEEDS.map((kmh, i) => {
      const at = c.peakAt[i], full = corner(at, true, kmh), half = corner(0.5 * at, true, kmh), right = kmh === 150 ? corner(-at, true, kmh) : null;
      log(c.id, 'analog', kmh, { full, half, share: r(full.steady / c.limitG[i]), halfShare: r(half.steady / full.steady) });
      return { full, half, right };
    });
    res.forEach(({ full, half, right }, i) => {
      expect(full.steady).toBeGreaterThan(0.9 * c.limitG[i]);
      expect(full.steady).toBeLessThan(1.05 * c.limitG[i]);
      expect(full.bodyDeg).toBeLessThan(8);
      expect(full.yawAfter).toBeLessThan(0.05);
      expect(half.steady).toBeLessThan(0.9 * full.steady);
      expect(half.steady).toBeGreaterThan(0.3 * full.steady);
      if (right) expect(Math.abs(right.steady + full.steady)).toBeLessThan(0.02 * full.steady);
    });
  });

  it('analog: the input is the rack position, the same at any speed', () => {
    // What the engine is sent (its steer is + = right) is the input itself at 30 km/h and at 250 km/h alike, once
    // the rack-rate limit has caught up; at low speed the front wheels turn that share of full lock (at speed the
    // GT3's steering flexes under the cornering force, so its wheels turn less than the rack asks)
    for (const kmh of [30, 250]) for (const steer of [0.05, -0.3, 1]) {
      const { v, out, tick } = rig(c, kmh);
      for (let t = 0; t < 0.6; t += DT) tick({ throttle: holdSpeed(v, kmh), brake: 0, steer, analog: true });
      expect(out.steer).toBe(-steer);
      if (kmh === 30 && steer === 0.05) expect(0.5 * (v.wheels[0].steerRad + v.wheels[1].steerRad) / v.maxSteerRad).toBeCloseTo(0.05, 2);
    }
  });

  it('steerAngle: a fixed road-wheel angle gives the geometric path at low speed', () => {
    const { v, tick } = rig(c, 20);
    const delta = 0.03;   // rad, left
    const k: number[] = [];
    for (let t = 0; t < 3; t += DT) {
      tick({ throttle: holdSpeed(v, 20), brake: 0, steer: 0, analog: true, steerAngle: delta });
      if (t > 2) k.push(yawRate(v) / v.speedMs);
    }
    const curvature = mean(k), geometric = Math.tan(delta) / c.wheelbase;
    log(c.id, 'steerAngle', { curvature, geometric, ratio: r(curvature / geometric) });
    expect(curvature / geometric).toBeGreaterThan(0.9);
    expect(curvature / geometric).toBeLessThan(1.1);
  });

  // VehiclePhysics.reset() leaves a little of the old run behind (the tyres' band load shares, the wheels' rotation),
  // so a reset car does not repeat a fresh one bit for bit. Instead: one driver is reset after a run, another is new,
  // on two engines with the same history; both then drive the same inputs.
  it('reset() forgets everything: a reset driver drives bit-identically to a new one', () => {
    const script = (k: number): [DriveInput, boolean] => {   // 3 s: keys into a corner on the brakes, then analog; TC off from 2.2 s
      const t = k * DT;
      return [t < 1.5 ? { throttle: t < 0.5 ? 1 : 0, brake: t < 0.5 ? 0 : 0.6, steer: t < 0.8 ? 0 : 1, analog: false }
        : { throttle: 1, brake: 0, steer: -0.4 + 0.1 * Math.sin(5 * t), analog: true }, t < 2.2];
    };
    const runs = [0, 1].map((n) => {
      const s = rig(c, 120);
      for (let k = 0; k < 360; k++) s.tick(...script(k));
      s.reset();
      if (n === 1) s.newDriver();
      for (let k = 0; k < 360; k++) s.tick(...script(k));
      const v = s.v;
      expect(s.oneStep()).toBe(true);
      return [...v.position.toArray(), ...v.quaternion.toArray(), ...v.velocity.toArray(), ...v.angularVelocity.toArray(),
              v.engineOmega, ...v.wheels.flatMap((w) => [w.omega, w.slipRatio, w.steerRad])];
    });
    expect(runs[0].every(Number.isFinite)).toBe(true);
    expect(runs[0].every((x, i) => Object.is(x, runs[1][i]))).toBe(true);
  });
});
