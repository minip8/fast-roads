// Port of LibreCorsa's `scripts/lib/gt3-reference.ts` (commit c31ac20): the GT3 measured the way their reference
// telemetry logs were, so the vendored engine can be checked against the table they publish. Only the import paths
// and the omission of the gearing/limiter figures (pure config arithmetic) differ from theirs.
import * as THREE from 'three';
import { FlatGroundQuery } from '../src/lc/vendor/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lc/vendor/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../src/lc/vendor/sim/gt3/AmgGt3Config';

/** [km/h, value] from their reference GT3 MoTeC logs: the speeds are the measurement points */
export const GT3_REF = {
  lateralG: [[81, 1.7], [99, 1.79], [117, 1.79], [153, 2.13], [171, 2.01]] as const,
  brakingG: [[99, 1.68], [117, 1.72], [153, 1.83], [189, 2.03], [225, 2.11], [243, 2.12]] as const,
  throttleG: [[63, 0.95], [99, 0.77], [135, 0.64], [171, 0.45], [207, 0.3], [243, 0.19]] as const,
  absFrontSlip: 0.077,
  tcRearSlip: 0.091,
};

export interface Gt3Measurement {
  /** [km/h, ours] */
  lateralG: [number, number][];
  understeerDegPerG: number;
  brakingG: [number, number][];
  throttleG: [number, number][];
}

/** The state the car is measured in: tyres at this carcass and tread temperature (°C), this much fuel (kg) */
export interface Gt3Conditions {
  tyreTempC?: number;
  fuelKg?: number;
}

/** Their reference runs' state: tyres mid-window, half a tank */
export const GT3_LOG_CONDITIONS: Gt3Conditions = { tyreTempC: 77, fuelKg: 25 };

const DT = 1 / 120;
const RHO = 1.2;

function run(car: VehiclePhysics, seconds: number, drive: (c: VehiclePhysics, t: number) => VehicleInputs, each?: (c: VehiclePhysics, t: number) => boolean): void {
  for (let t = 0; t < seconds; t += DT) {
    car.step(DT, drive(car, t));
    if (each?.(car, t)) break;
  }
}

const bodySlip = (c: VehiclePhysics) => {
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion);
  const lat = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);
  return Math.atan2(c.velocity.dot(lat), c.velocity.dot(fwd));
};

export function makeGt3(v0 = 0, conditions: Gt3Conditions = GT3_LOG_CONDITIONS, cfg = AMG_GT3_CONFIG): VehiclePhysics {
  const c = new VehiclePhysics({ ground: new FlatGroundQuery(0), config: cfg, airDensity: RHO });
  if (conditions.fuelKg) {
    c.setFuelMass(conditions.fuelKg);
    c.refreshStaticGeometry();
  }
  c.reset(0, 0, 0, v0);
  const warm = conditions.tyreTempC;
  if (warm !== undefined) {
    for (const w of c.wheels) {
      w.surfaceTempC = w.coreTempC = warm;
      for (let b = 0; b < 3; b++) w.bandTempsC[b] = w.bandCoreTempsC[b] = w.bandCarcassTempsC[b] = warm;
      w.circumferentialTempsC.fill(warm);
    }
  }
  return c;
}

/** Sustained (best 1 s) lateral g at `kmh` on a slow steer ramp, and the road-wheel degrees per g in the linear range */
export function measureLateral(kmh: number, conditions = GT3_LOG_CONDITIONS, cfg = AMG_GT3_CONFIG): { g: number; degPerG: number } {
  const car = makeGt3(kmh / 3.6, conditions, cfg);
  let pedal = 0.3;
  const hist: number[] = [];
  let best = 0;
  const pts: [number, number][] = [];
  let steer = 0;
  run(car, 14, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    // Full lock is reached at 81 km/h; faster, the ramp tops out where the same lateral g needs it (∝ 1/v²)
    steer = Math.min(1, t / 14) * 0.9 * Math.min(1, 1.6 * (81 / kmh) ** 2);
    return { throttle: pedal, brake: 0, steer: -steer };
  }, (c, t) => {
    const ay = Math.abs(c.telemetry.latG);
    hist.push(ay);
    if (hist.length > 120) hist.shift();
    if (hist.length === 120) best = Math.max(best, hist.reduce((a, b) => a + b, 0) / 120);
    if (ay > 0.2 && ay < 1.0 && t > 1) pts.push([ay, steer * cfg.chassis.maxRoadWheelDeg]);
    return Math.abs(bodySlip(c)) > 0.35;
  });
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const k = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return { g: best, degPerG: k };
}

/** Threshold-braking g at `kmh`: the mean over the 3 m/s around it, slip held at the reference ABS level */
export function measureBraking(kmh: number, conditions = GT3_LOG_CONDITIONS, cfg = AMG_GT3_CONFIG): number {
  const v = kmh / 3.6;
  const car = makeGt3(v + 8, conditions, cfg);
  let pedal = 1;
  let tAbove = NaN;
  let g = NaN;
  let prevSpeed = v + 8;
  let prevT = 0;
  const crossed = (at: number, speed: number, t: number) => prevT + ((prevSpeed - at) / Math.max(1e-9, prevSpeed - speed)) * (t - prevT);
  run(car, 4, (c) => {
    const sr = Math.min(...c.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -GT3_REF.absFrontSlip ? -0.08 : 0.04), 0.2, 1);
    return { throttle: 0, brake: pedal, steer: 0 };
  }, (c, t) => {
    const speed = c.telemetry.speedKmh / 3.6;
    if (Number.isNaN(tAbove) && speed <= v + 1.5) tAbove = crossed(v + 1.5, speed, t);
    if (speed <= v - 1.5) {
      g = 3 / (crossed(v - 1.5, speed, t) - tAbove) / 9.81;
      return true;
    }
    prevSpeed = speed;
    prevT = t;
    return false;
  });
  return g;
}

/** Full-throttle g as the car passes each of `speeds` (km/h), rear slip held at the reference TC level */
export function measureThrottle(speeds: readonly number[], conditions = GT3_LOG_CONDITIONS, cfg = AMG_GT3_CONFIG): number[] {
  const car = makeGt3(40 / 3.6, conditions, cfg);
  let pedal = 0.6;
  const seen = new Map<number, number>();
  run(car, 60, (c) => {
    const sr = Math.max(c.wheels[2].slipRatio, c.wheels[3].slipRatio);
    pedal = THREE.MathUtils.clamp(pedal + (GT3_REF.tcRearSlip - sr) * 0.25, 0.3, 1);
    return { throttle: pedal, brake: 0, steer: 0 };
  }, (c) => {
    for (const kmh of speeds) if (!seen.has(kmh) && c.telemetry.speedKmh >= kmh) seen.set(kmh, c.telemetry.lonG);
    return seen.size === speeds.length;
  });
  return speeds.map((kmh) => seen.get(kmh) ?? NaN);
}

/** Every reference manoeuvre, as their `measureGt3` runs them */
export function measureGt3(conditions = GT3_LOG_CONDITIONS, cfg = AMG_GT3_CONFIG): Gt3Measurement {
  const lateral = GT3_REF.lateralG.map(([kmh]) => ({ kmh, ...measureLateral(kmh, conditions, cfg) }));
  // dδ/da_y = 57.3·L·g / v² + K: the intercept against 1/v² is the understeer gradient
  const slopes = lateral.map((l) => ({ invV2: 1 / (l.kmh / 3.6) ** 2, degPerG: l.degPerG }));
  const n = slopes.length;
  const mx = slopes.reduce((a, p) => a + p.invV2, 0) / n;
  const my = slopes.reduce((a, p) => a + p.degPerG, 0) / n;
  const m = slopes.reduce((a, p) => a + (p.invV2 - mx) * (p.degPerG - my), 0) / slopes.reduce((a, p) => a + (p.invV2 - mx) ** 2, 0);
  const brakingG = GT3_REF.brakingG.map(([kmh]): [number, number] => [kmh, measureBraking(kmh, conditions, cfg)]);
  const throttleSpeeds = GT3_REF.throttleG.map(([kmh]) => kmh);
  const throttle = measureThrottle(throttleSpeeds, conditions, cfg);
  return {
    lateralG: lateral.map((l) => [l.kmh, l.g]),
    understeerDegPerG: my - m * mx,
    brakingG,
    throttleG: throttleSpeeds.map((kmh, i) => [kmh, throttle[i]]),
  };
}
