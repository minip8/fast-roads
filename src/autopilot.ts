import type { CarInfo } from './cars';
import type { GripPlan } from './conditions';
import { laneAt, lanePoint, laneLapS, sampleAt, type LanePos, type PitLane } from './pitLane';
import { inPitLane, pointAt, type Track } from './track';
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

// The autopilot's part in a pit stop (a race weekend: Weekend.pitPlan): `stop`, it drives into the pit lane this lap
// and stops in the box. Without one (or with stop false) a car in the lane drives out along it.
export interface PitPlan { stop: boolean }

const at = { d: 0 }, lp: LanePos = { d: 0, off: 0, k: 0 };
export function autopilot(car: Vehicle, tr: Track, lat = 0, pit: PitPlan | null = null): DriveInput {
  const l = tr.pit;
  if (l) {
    if (inPitLane(tr, car.pos.x, car.pos.z, car.proj.i, at)) return laneDrive(car, tr, l, at.d, !!pit?.stop);
    if (pit?.stop) {
      // (on the lane's road where it starts on the track's: into it)
      if (laneAt(l, car.pos.x, car.pos.z, lp) && lp.d < l.nose + 5) return laneDrive(car, tr, l, lp.d, true);
      const ahead = ((l.sStart - car.proj.s) % tr.L + tr.L) % tr.L;
      if (ahead < 600) return pitApproach(car, tr, l, ahead);
    }
  }
  const v = Math.max(0, car.speedF), s = car.proj.s;
  const Ld = 8 + v * 0.3;
  const tgt = pointAt(tr, s + Ld, lat);
  const plan = car.gripPlan(), prof = speedPlan(car, tr, plan);
  const vt = prof[pointAt(tr, s + 4 + v * 0.12).i];
  // Running out of road on the outside of a bend (the drift car sliding wide under power in a long fast curve, as in
  // Monza's Curva Grande): lift, more the further out, so the tyres bring it back. Off (x1) until the car is within
  // 1.5 m of the edge, which no pinned lap at Melbourne or Silverstone comes to (they keep 1.53 m or more).
  const { i, lat: off } = car.proj;
  const wide = Math.abs(off) - ((off > 0 ? tr.WL[i] : tr.WR[i]) - 1.5);
  const lift = wide > 0 && Math.sign(off) !== Math.sign(tr.KS[i]) ? clamp(1 - wide, 0, 1) : 1;
  return follow(car, tgt.x, tgt.z, Ld, vt, lift, plan);
}

// Pure pursuit of (x, z), Ld m ahead, at target speed vt (lift: a share of the throttle; plan: the car's grip plan).
function follow(car: Vehicle, x: number, z: number, Ld: number, vt: number, lift: number, plan: GripPlan | null): DriveInput {
  const v = Math.max(0, car.speedF);
  const rx = x - car.pos.x, rz = z - car.pos.z;
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
  const liftK = plan ? Math.max(car.spec.autoLift, PLAN_LIFT) : car.spec.autoLift;
  const counter = plan ? Math.max(car.spec.autoCounter, PLAN_COUNTER) : car.spec.autoCounter;
  const steerAngle = Math.atan((2 * wb * Math.sin(a)) / Ld) + counter * slide + car.spec.autoUndersteer * v * v * (2 * Math.sin(a)) / Ld;
  return { throttle: clamp((vt - v) * 0.5, 0, 1) * clamp(1 - liftK * Math.abs(slide), 0, 1) * lift, brake: clamp((v - vt) * 0.4, 0, 1), steer: 0, analog: true, steerAngle, autoGears: true };
}

// ---------------------------------------------------------------------------- the pit lane
// In the lane the autopilot follows the lane's path (the fast lane's middle), at its own speed plan: the lane's bends,
// just under the limit between the limit lines (the limiter cuts the throttle there, and nothing else), braking for
// the first limit line as a driver must, and on to the track's plan where the lane rejoins. Stopping, it pulls over
// into the working lane and brakes to a stop at the box's middle (at BOX_DECEL); the box serves it, then it drives out.
const BOX_DECEL = 4;          // m/s²: the stop in the box
const LIMIT_DECEL = 0.6;      // share of the car's low-speed braking (CarInfo.autoLong) for the limit line

function laneProfile(car: Vehicle, tr: Track, l: PitLane): Float64Array {
  const cache = (l as { plans?: Map<string, Float64Array> }).plans ??= new Map(), spec = car.spec;
  let v = cache.get(spec.id);
  if (v) return v;
  const n = l.n, k = new Float64Array(n);
  for (let j = 1; j < n - 1; j++) {
    const turn = Math.asin(clamp(l.TX[j - 1] * l.TZ[j + 1] - l.TZ[j - 1] * l.TX[j + 1], -1, 1));
    k[j] = turn / (l.D[j + 1] - l.D[j - 1] || 1);
  }
  const muLat = spec.autoGrip * 1.65 * Math.min(spec.gripFront, spec.gripRear) * 9.81 * 0.8, muLong = spec.autoLong * 9.81 * LIMIT_DECEL;
  v = new Float64Array(n);
  const end = dryPlan(spec, tr)[pointAt(tr, laneLapS(l, tr.L, l.len)).i];
  for (let j = 0; j < n; j++) {
    v[j] = Math.min(95, Math.sqrt(muLat / Math.max(1e-6, Math.abs(k[j]))));
    if (l.D[j] >= l.limIn - 2 && l.D[j] <= l.limOut) v[j] = Math.min(v[j], l.limitMs - 1);
  }
  v[n - 1] = Math.min(v[n - 1], end);
  for (let j = n - 2; j >= 0; j--) v[j] = Math.min(v[j], Math.sqrt(v[j + 1] ** 2 + 2 * muLong * (l.D[j + 1] - l.D[j])));
  cache.set(spec.id, v);
  return v;
}

// The lateral offset (from the path, + towards the far side) the car keeps d m along: the working lane's middle round
// the box when stopping (in over 40 m before it), else the path.
function laneOffset(l: PitLane, d: number, stop: boolean) {
  if (!stop) return 0;
  const f = clamp(1 - (l.box - d - 5) / 40, 0, 1);
  return l.boxOff * f * f * (3 - 2 * f);
}

function laneDrive(car: Vehicle, tr: Track, l: PitLane, d: number, stop: boolean): DriveInput {
  const v = Math.max(0, car.speedF), Ld = 6 + v * 0.3, prof = laneProfile(car, tr, l);
  stop = stop && d < l.box + 4;
  let vt = prof[sampleAt(l, d + 3 + v * 0.12)];
  if (stop) {
    const left = l.box - d;
    if (left <= 0.4) return { throttle: 0, brake: Math.abs(car.speedF) > 0.3 ? 1 : 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };
    vt = Math.min(vt, Math.max(1.2, Math.sqrt(2 * BOX_DECEL * left)) * (left < 2 ? left / 2 : 1));
  }
  const ahead = d + Ld;
  if (ahead > l.len) {   // (out of the lane's end: the track beyond it)
    const p = pointAt(tr, laneLapS(l, tr.L, l.len) + (ahead - l.len));
    return follow(car, p.x, p.z, Ld, vt, 1, car.gripPlan());
  }
  const p = lanePoint(l, ahead, laneOffset(l, ahead, stop));
  return follow(car, p.x, p.z, Ld, vt, 1, car.gripPlan());
}

// On the track, `ahead` m before the lane's start, to stop this lap: the track's line and plan, then the lane's path
// once the look-ahead reaches it, braking for the lane's first bends and limit line at LIMIT_DECEL of the car's
// braking.
function pitApproach(car: Vehicle, tr: Track, l: PitLane, ahead: number): DriveInput {
  const v = Math.max(0, car.speedF), Ld = 8 + v * 0.3, s = car.proj.s;
  const decel = car.spec.autoLong * 9.81 * LIMIT_DECEL;
  // (the lane's own plan at its start carries its first bends and the limit line: braked for from here)
  const plan = car.gripPlan();
  const vt = Math.min(speedPlan(car, tr, plan)[pointAt(tr, s + 4 + v * 0.12).i], Math.sqrt(laneProfile(car, tr, l)[0] ** 2 + 2 * decel * Math.max(0, ahead - 3)));
  const p = Ld > ahead ? lanePoint(l, Ld - ahead) : pointAt(tr, s + Ld);
  return follow(car, p.x, p.z, Ld, vt, 1, plan);
}
