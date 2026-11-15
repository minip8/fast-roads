// The vendored LibreCorsa car engine (src/lc/vendor) running headless on flat ground: both cars drive sanely, the
// engine is deterministic, and the GT3 reproduces the reference table LibreCorsa publishes for it.
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CarPhysicsConfig } from '../src/lc/vendor/sim/f12026-car/F12026CarConfig';
import { LC26_TUNED_CONFIG } from '../src/lc/vendor/sim/f12026-car/Lc26Tune';
import { FlatGroundQuery } from '../src/lc/vendor/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lc/vendor/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../src/lc/vendor/sim/gt3/AmgGt3Config';
import { type Gt3Measurement, measureGt3 } from './lc-gt3-reference';

const DT = 1 / 120;   // the game's tick; step() runs its own fixed 500 Hz steps inside
const G = 9.81;

const makeCar = (config: CarPhysicsConfig, v0 = 0) => {
  const car = new VehiclePhysics({ ground: new FlatGroundQuery(0), config });
  car.reset(0, 0, 0, v0);
  return car;
};

const finite = (car: VehiclePhysics) =>
  car.stateIsSane() &&
  [car.telemetry.speedKmh, car.telemetry.rpm, car.telemetry.latG, car.telemetry.lonG].every(Number.isFinite) &&
  car.wheels.every((w) => [w.fz, w.fx, w.fy, w.compression, w.surfaceTempC, w.slipAngleRad].every(Number.isFinite));

// Body slip angle (rad): +x is the car's left, +z its nose
const bodySlip = (car: VehiclePhysics) => {
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
  const left = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
  return Math.atan2(car.velocity.dot(left), car.velocity.dot(fwd));
};

// Brake pedal that holds the most-slipping wheel near `slip`: the engine has no ABS of its own (the game adds it)
const absPedal = (car: VehiclePhysics, pedal: number, slip = 0.08) =>
  THREE.MathUtils.clamp(pedal + (Math.min(...car.wheels.map((w) => w.slipRatio)) < -slip ? -0.08 : 0.04), 0.2, 1);

interface Bounds {
  zeroTo100: [number, number];   // s
  at10s: [number, number];       // km/h after 10 s flat out
  brake200to100: [number, number]; // mean g
  corner100: [number, number];   // |lateral g| at 100 km/h, steer 0.3
}

const CASES: [string, CarPhysicsConfig, Bounds][] = [
  ['GT3', AMG_GT3_CONFIG, { zeroTo100: [2.8, 4.3], at10s: [190, 230], brake200to100: [1.6, 2.4], corner100: [1.5, 2.1] }],
  ['LC26', LC26_TUNED_CONFIG, { zeroTo100: [2.1, 3.3], at10s: [255, 310], brake200to100: [2.0, 3.5], corner100: [1.8, 2.6] }],
];

describe.each(CASES)('LibreCorsa engine: %s', (_name, config, bounds) => {
  it('settles on its wheels, accelerates, brakes to a stop', () => {
    const car = makeCar(config);
    const mg = car.totalMassKg * G;
    expect(finite(car)).toBe(true);
    expect(car.wheels.every((w) => w.fz > 0.15 * mg && w.fz < 0.35 * mg)).toBe(true);
    expect(car.wheels.reduce((a, w) => a + w.fz, 0) / mg).toBeCloseTo(1, 1);
    expect(car.position.y).toBeGreaterThan(0.15);
    expect(car.position.y).toBeLessThan(0.6);
    expect(car.velocity.length()).toBeLessThan(0.01);

    // Flat out from rest (no traction control: that is the game's)
    let t = 0, t100 = NaN, allFinite = true;
    for (; t < 10; t += DT) {
      car.step(DT, { throttle: 1, brake: 0, steer: 0 });
      allFinite &&= finite(car);
      if (Number.isNaN(t100) && car.telemetry.speedKmh >= 100) t100 = t;
    }
    expect(allFinite).toBe(true);
    expect(t100).toBeGreaterThan(bounds.zeroTo100[0]);
    expect(t100).toBeLessThan(bounds.zeroTo100[1]);
    expect(car.telemetry.speedKmh).toBeGreaterThan(bounds.at10s[0]);
    expect(car.telemetry.speedKmh).toBeLessThan(bounds.at10s[1]);
    expect(car.gear).toBeGreaterThanOrEqual(4);
    expect(Math.abs(car.position.x)).toBeLessThan(1);   // straight down +z
    expect(car.position.z).toBeGreaterThan(300);

    // Threshold braking: mean deceleration from 200 to 100 km/h, then to a stop
    let pedal = 1, tA = NaN, tB = NaN, tb = 0;
    for (; tb < 8 && car.telemetry.speedKmh > 1; tb += DT) {
      pedal = absPedal(car, pedal);
      car.step(DT, { throttle: 0, brake: pedal, steer: 0 });
      allFinite &&= finite(car);
      if (Number.isNaN(tA) && car.telemetry.speedKmh <= 200) tA = tb;
      if (Number.isNaN(tB) && car.telemetry.speedKmh <= 100) tB = tb;
    }
    const decel = (100 / 3.6) / (tB - tA) / G;
    expect(decel).toBeGreaterThan(bounds.brake200to100[0]);
    expect(decel).toBeLessThan(bounds.brake200to100[1]);
    expect(car.telemetry.speedKmh).toBeLessThan(1);
    // Held on the brakes it stays put (the LC26 rocks a few mm on its locked tyres)
    const stopped = car.position.clone();
    for (let k = 0; k < 240; k++) car.step(DT, { throttle: 0, brake: 1, steer: 0 });
    expect(car.position.distanceTo(stopped)).toBeLessThan(0.1);
    expect(allFinite && finite(car)).toBe(true);
  });

  it('holds a steady corner at 100 km/h', () => {
    const car = makeCar(config, 100 / 3.6);
    let pedal = 0.3, maxSlip = 0, allFinite = true;
    const lat: number[] = [];
    for (let t = 0; t < 4; t += DT) {
      pedal = THREE.MathUtils.clamp(pedal + (car.telemetry.speedKmh < 100 ? 0.02 : -0.02), 0, 1);
      car.step(DT, { throttle: pedal, brake: 0, steer: 0.3 });   // + steer is right
      allFinite &&= finite(car);
      maxSlip = Math.max(maxSlip, Math.abs(bodySlip(car)));
      if (t > 3) lat.push(car.telemetry.latG);
    }
    const meanLat = lat.reduce((a, b) => a + b, 0) / lat.length;
    expect(allFinite).toBe(true);
    expect(meanLat).toBeLessThan(-bounds.corner100[0]);   // latG is + left: a right turn reads negative
    expect(meanLat).toBeGreaterThan(-bounds.corner100[1]);
    expect(car.angularVelocity.y).toBeLessThan(-0.3);      // yawing right
    expect(maxSlip).toBeLessThan(6 * Math.PI / 180);
    expect(car.telemetry.speedKmh).toBeGreaterThan(90);
    expect(car.telemetry.speedKmh).toBeLessThan(110);
  });
});

it('LibreCorsa engine: the same inputs give bit-identical state', () => {
  const drive = (): number[] => {
    const car = makeCar(LC26_TUNED_CONFIG);
    for (let k = 0; k < 1200; k++) {   // 10 s: launch, brake, turn, a shift by hand
      const t = k * DT;
      const inp: VehicleInputs = t < 4 ? { throttle: 1, brake: 0, steer: 0 }
        : t < 5 ? { throttle: 0, brake: 0.7, steer: 0.1 }
        : { throttle: 0.6, brake: 0, steer: -0.4 + 0.1 * Math.sin(t), shiftDown: k === 610 };
      car.step(DT, inp);
    }
    return [
      ...car.position.toArray(), ...car.quaternion.toArray(), ...car.velocity.toArray(), ...car.angularVelocity.toArray(),
      car.engineOmega, car.gear, ...car.wheels.flatMap((w) => [w.omega, w.hubY, w.slipRatio, w.surfaceTempC, w.wear]),
    ];
  };
  const a = drive(), b = drive();
  expect(a.every(Number.isFinite)).toBe(true);
  expect(b).toEqual(a);
  expect(a.every((v, i) => Object.is(v, b[i]))).toBe(true);
});

describe('LibreCorsa engine: GT3 against their reference table', () => {
  let m: Gt3Measurement;
  let ours: Record<'lateral' | 'braking' | 'throttle', number[]>;
  beforeAll(() => {
    m = measureGt3();
    ours = { lateral: m.lateralG.map((p) => p[1]), braking: m.brakingG.map((p) => p[1]), throttle: m.throttleG.map((p) => p[1]) };
  });

  // Their own scripts/lib/gt3-reference.ts, run unmodified on their code at the vendored commit (c31ac20): the copy
  // must match it to rounding
  it('matches their code at the vendored commit', () => {
    const upstream = {
      lateral: [1.71964, 1.75851, 1.80486, 1.92154, 1.98683],
      braking: [1.67900, 1.72934, 1.90287, 2.12339, 2.17120, 2.18207],
      throttle: [0.84924, 0.83526, 0.59082, 0.44805, 0.30774, 0.19700],
    };
    for (const k of ['lateral', 'braking', 'throttle'] as const)
      ours[k].forEach((v, i) => expect(v).toBeCloseTo(upstream[k][i], 4));
    expect(m.understeerDegPerG).toBeCloseTo(1.41391, 4);
  });

  // The table in their docs/physics/README.md, generated at their earlier commit e9a40ab. Their physics moved a little
  // between that commit and c31ac20 (the unmodified upstream code gives the numbers above), by up to 4 %
  it('lands near their published table', () => {
    const published = {
      lateral: [1.709, 1.748, 1.800, 1.916, 1.976],
      braking: [1.658, 1.766, 1.946, 2.107, 2.169, 2.177],
      throttle: [0.846, 0.829, 0.598, 0.433, 0.308, 0.205],
    };
    for (const k of ['lateral', 'braking', 'throttle'] as const)
      ours[k].forEach((v, i) => expect(Math.abs(v / published[k][i] - 1)).toBeLessThan(0.05));
    expect(Math.abs(m.understeerDegPerG - 1.42)).toBeLessThan(0.05);
  });
});
