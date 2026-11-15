import type { Car, DriveInput } from './car';
import type { CarSpec } from './cars';
import { pointAt, type Track } from './track';
import { clamp, smoothClosed } from './util';

// ============================================================================
// Autopilot (demo / testing): pure pursuit on the centerline + precomputed speed profile
// ============================================================================
export function buildSpeedProfile(tr: Track, spec: CarSpec): Float64Array {
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

export function autopilot(car: Car, tr: Track, lat = 0): DriveInput {
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
  const steerAngle = Math.atan((2 * wb * Math.sin(a)) / Ld) + car.spec.autoCounter * slide + car.spec.autoUndersteer * v * v * (2 * Math.sin(a)) / Ld;
  const profs = tr.speedProfiles || (tr.speedProfiles = {});
  const prof = profs[car.spec.id] || (profs[car.spec.id] = buildSpeedProfile(tr, car.spec));
  const vt = prof[pointAt(tr, s + 4 + v * 0.12).i];
  return { throttle: clamp((vt - v) * 0.5, 0, 1) * clamp(1 - car.spec.autoLift * Math.abs(slide), 0, 1), brake: clamp((v - vt) * 0.4, 0, 1), steer: 0, analog: true, steerAngle, autoGears: true };
}
