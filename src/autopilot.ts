import type { CarInfo } from './cars';
import type { GripPlan } from './conditions';
import { pointAt, type Track } from './track';
import { clamp, smoothClosed } from './util';
import type { DriveInput, Vehicle } from './vehicle';

// ============================================================================
// Autopilot (demo / testing): pure pursuit on the centerline + precomputed speed profile
// ============================================================================
// The speed plan for the dry, fresh-tyre grip the spec's numbers are about, or with `grip` (a share of that grip at
// a speed, Vehicle.gripPlan) for worn tyres or a wet track: each point's cornering speed is then the highest at which
// the grip there still holds the curve, and the braking uses the grip at each speed.
export function buildSpeedProfile(tr: Track, spec: CarInfo, grip?: (speedMs: number) => number): Float64Array {
  if (grip) return gripProfile(tr, spec, grip);
  const N = tr.N, k = smoothClosed(tr.K, 3, 1);
  const c = (0.5 * spec.rho * spec.ClA) / (spec.mass * 9.81);       // downforce per (m/s)^2, as a fraction of weight
  const muLat = spec.autoGrip * 1.65 * Math.min(spec.gripFront, spec.gripRear) * 9.81, muLong = spec.autoLong * 9.81;
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const den = Math.abs(k[i]) - muLat * c;
    v[i] = den > 0 ? Math.min(95, Math.sqrt(muLat / den)) : 95;
  }
  // backward pass: can we brake in time for what's coming?
  for (let pass = 0; pass < 2; pass++) {
    for (let n = N - 1; n >= 0; n--) {
      const i = n, j = (n + 1) % N, ds = tr.S[i + 1] - tr.S[i];
      const vn = v[j], ab = muLong * (1 + c * vn * vn);
      v[i] = Math.min(v[i], Math.sqrt(vn * vn + 2 * ab * ds));
    }
  }
  return v;
}

function gripProfile(tr: Track, spec: CarInfo, grip: (speedMs: number) => number): Float64Array {
  const N = tr.N, k = smoothClosed(tr.K, 3, 1);
  const c = (0.5 * spec.rho * spec.ClA) / (spec.mass * 9.81);
  const muLat = spec.autoGrip * 1.65 * Math.min(spec.gripFront, spec.gripRear) * 9.81, muLong = spec.autoLong * 9.81;
  const v = new Float64Array(N);
  // the highest speed (bisection: the grip need not fall steadily with speed) at which muLat g(v) (1 + c v^2) >= |k| v^2
  const holds = (x: number, ak: number) => muLat * grip(x) * (1 + c * x * x) >= ak * x * x;
  for (let i = 0; i < N; i++) {
    const ak = Math.abs(k[i]);
    if (holds(95, ak)) { v[i] = 95; continue; }
    let lo = 0, hi = 95;
    for (let it = 0; it < 24; it++) { const m = 0.5 * (lo + hi); if (holds(m, ak)) lo = m; else hi = m; }
    v[i] = lo;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let n = N - 1; n >= 0; n--) {
      const i = n, j = (n + 1) % N, ds = tr.S[i + 1] - tr.S[i];
      const vn = v[j], ab = muLong * grip(vn) * (1 + c * vn * vn);
      v[i] = Math.min(v[i], Math.sqrt(vn * vn + 2 * ab * ds));
    }
  }
  return v;
}

// The speed plan for dry, fresh tyres, cached per car.
export function dryPlan(spec: CarInfo, tr: Track): Float64Array {
  const profs = tr.speedProfiles || (tr.speedProfiles = {});
  return profs[spec.id] || (profs[spec.id] = buildSpeedProfile(tr, spec));
}

// The car's speed plan: the cached dry one, or one for its grip plan (cached by the plan's key, the most recent few:
// a race's wear and weather go through a few dozen).
const PLAN_CACHE = 48;
export function speedPlan(car: Vehicle, tr: Track, plan: GripPlan | null = car.gripPlan()): Float64Array {
  if (!plan) return dryPlan(car.spec, tr);
  const cache = tr.gripProfiles || (tr.gripProfiles = new Map()), key = car.spec.id + '|' + plan.key;
  let prof = cache.get(key);
  if (prof) { cache.delete(key); cache.set(key, prof); return prof; }   // most recently used last
  prof = buildSpeedProfile(tr, car.spec, (x) => plan.at(x));
  cache.set(key, prof);
  if (cache.size > PLAN_CACHE) cache.delete(cache.keys().next().value!);
  return prof;
}

// With a grip plan (worn tyres, a wet track): throttle lifted per radian of slide past 4 deg (as the drift car's
// autoLift), and wheel angle per radian of it steered into the slide (the drift car's autoCounter is 0.9).
const PLAN_LIFT = 6, PLAN_COUNTER = 0.6;

export function autopilot(car: Vehicle, tr: Track, lat = 0): DriveInput {
  const v = Math.max(0, car.speedF), s = car.proj.s;
  const Ld = 8 + v * 0.3;
  const tgt = pointAt(tr, s + Ld, lat);
  const rx = tgt.x - car.pos.x, rz = tgt.z - car.pos.z;
  const xl = rx * car.left.x + rz * car.left.z, zf = rx * car.fwd.x + rz * car.fwd.z;
  const a = Math.atan2(xl, zf);
  const wb = car.spec.zFront - car.spec.zRear;
  // counter-steer: point the wheels toward where the car is actually going when the tail is out
  const beta = Math.atan2(car.vel.dot(car.left), Math.max(Math.abs(car.speedF), 3));
  const slide = Math.sign(beta) * Math.max(0, Math.abs(beta) - 0.07);   // ignore the normal few degrees of slip
  // Pure pursuit asks for a path curvature (2 sin a / Ld). A neutral car gets it from the geometric wheel angle; one
  // that understeers needs more the harder it corners.
  // With less grip than the plan's dry, fresh tyres (worn, wet), the throttle also lifts as the tail steps out, as
  // the drift car's always does: TC holds the wheelspin, not the slide, and full power out of a wet corner spun the F1.
  const plan = car.gripPlan(), liftK = plan ? Math.max(car.spec.autoLift, PLAN_LIFT) : car.spec.autoLift;
  const counter = plan ? Math.max(car.spec.autoCounter, PLAN_COUNTER) : car.spec.autoCounter;
  const steerAngle = Math.atan((2 * wb * Math.sin(a)) / Ld) + counter * slide + car.spec.autoUndersteer * v * v * (2 * Math.sin(a)) / Ld;
  const prof = speedPlan(car, tr, plan);
  const vt = prof[pointAt(tr, s + 4 + v * 0.12).i];
  // Running out of road on the outside of a bend (the drift car sliding wide under power in a long fast curve, as in
  // Monza's Curva Grande): lift, more the further out, so the tyres bring it back. Off (x1) until the car is within
  // 1.5 m of the edge, which no pinned lap at Melbourne or Silverstone comes to (they keep 1.53 m or more).
  const { i, lat: at } = car.proj, wide = Math.abs(at) - ((at > 0 ? tr.WL[i] : tr.WR[i]) - 1.5);
  const lift = wide > 0 && Math.sign(at) !== Math.sign(tr.KS[i]) ? clamp(1 - wide, 0, 1) : 1;
  return { throttle: clamp((vt - v) * 0.5, 0, 1) * clamp(1 - liftK * Math.abs(slide), 0, 1) * lift, brake: clamp((v - vt) * 0.4, 0, 1), steer: 0, analog: true, steerAngle, autoGears: true };
}
