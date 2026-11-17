import { STATE_FLAG, seqNewer, type CarState } from './protocol';

// ============================================================================
// A remote car (proxy) from the states its owner sends: give it each received state with its time on the relay
// clock (push), ask it for the car at any relay time (sample). Pure maths: no three.js, no Vehicle.
//
// - Past the newest state (the usual case: proxies are shown at the present) the car is extrapolated from it with
//   constant turn rate and velocity: the velocity turns with the angular velocity (so a car on a curve stays on the
//   curve), its speed changes at the acceleration seen between the last two states (along the velocity only,
//   capped at ACCEL_CAP), and the body turns at its angular velocity. At most `maxExtrapolate` s: after that it holds.
// - Between buffered states (asking for a time in the past) positions are cubic Hermite from the states' positions
//   and velocities, rotations normalised lerp, the rest linear. Before the oldest buffered state it holds that one.
// - A state that is not newer than the newest (by sequence number: duplicates, late and reordered packets) is
//   dropped. One much older in time than the newest (the sender's clock jumped back) starts the buffer again.
// - Corrections: when a state arrives, the pose the proxy was showing and the new prediction usually differ a
//   little. The difference (position and rotation) is kept as an offset that decays exponentially (time constant
//   `blendTau`), so the car glides onto the new path instead of jumping. More than `snapDistance` m, or a new
//   restart epoch (the car was put back at the start spot), and it snaps.
// - Staleness: `age` is how far the sample time is past the newest state. Past `collideAge` the proxy is not
//   collidable (nor while its owner sets STATE_FLAG.noCollide); `alpha` fades it from 1 at `fadeStart` to 0 at
//   `fadeEnd`, for drawing (a car that stopped sending: a lost connection, a tab in the background).
// ============================================================================
export interface RemoteOptions {
  maxExtrapolate: number;   // s
  collideAge: number;       // s
  fadeStart: number; fadeEnd: number;   // s
  blendTau: number;         // s
  snapDistance: number;     // m
  history: number;          // states kept for sampling in the past
  accel: boolean;           // extrapolate the speed change (false: constant speed)
  futureLimit: number;      // s: states stamped further ahead of `now` than this are dropped (a broken clock)
}
export const REMOTE_DEFAULTS: RemoteOptions = {
  maxExtrapolate: 0.35, collideAge: 0.4, fadeStart: 0.5, fadeEnd: 1.5,
  blendTau: 0.05, snapDistance: 4, history: 8, accel: true, futureLimit: 2,
};
const ACCEL_CAP = 60;       // m/s^2: no car brakes harder (an F1 car manages about 50)
const SUBSTEP = 0.01;       // s, integration step of the extrapolation

// A received state: the car state, its sequence number and its time on the relay clock (s, unwrapped).
export interface TimedState extends CarState { seq: number; time: number }

// What sample() fills in.
export interface RemoteSample extends CarState {
  time: number;             // the time asked for
  age: number;              // s since the newest state (negative: sampled in the past, between states)
  extrapolated: number;     // s actually extrapolated (<= maxExtrapolate)
  collidable: boolean;
  alpha: number;            // 1 .. 0 as the proxy goes stale
  correction: number;       // m of correction still being blended out (0 with smooth off)
}
export function emptySample(): RemoteSample {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, steer: 0, throttle: 0,
    brake: 0, gear: 0, rpm: 0, flags: 0, epoch: 0, compound: 0, reason: 0, time: 0, age: 0, extrapolated: 0, collidable: false, alpha: 0, correction: 0 };
}

export interface RemoteStats { received: number; accepted: number; stale: number; future: number; snaps: number }

export class RemoteCar {
  readonly opt: RemoteOptions;
  readonly stats: RemoteStats = { received: 0, accepted: 0, stale: 0, future: 0, snaps: 0 };
  private buf: TimedState[] = [];      // oldest first
  private accel = 0;                   // m/s^2 along the velocity, from the last two states
  // correction offset: position and rotation (quaternion: shown = off * predicted), as of offTime
  private ox = 0; private oy = 0; private oz = 0;
  private oqx = 0; private oqy = 0; private oqz = 0; private oqw = 1;
  private offTime = 0;
  private readonly tmp = emptySample(); private readonly tmp2 = emptySample();

  constructor(opt: Partial<RemoteOptions> = {}) { this.opt = { ...REMOTE_DEFAULTS, ...opt }; }

  get newest(): TimedState | null { return this.buf.length ? this.buf[this.buf.length - 1] : null; }
  get hasState() { return this.buf.length > 0; }

  // A state received at relay time `now`. Returns whether it was used. The state is copied.
  push(s: TimedState, now: number): boolean {
    this.stats.received++;
    const last = this.newest;
    if (last && !seqNewer(s.seq, last.seq)) { this.stats.stale++; return false; }
    if (s.time > now + this.opt.futureLimit) { this.stats.future++; return false; }
    // what is on screen now, before the new state changes the prediction
    const shown = last ? this.sample(now, this.tmp, true) : null;   // (tmp: kept until the offset is set)
    const copy = { ...s };
    if (last && (s.time <= last.time || s.epoch !== last.epoch)) this.buf.length = 0;   // a clock jump / a restart
    const prev = this.newest;
    this.buf.push(copy);
    if (this.buf.length > this.opt.history) this.buf.shift();
    this.accel = 0;
    if (prev && this.opt.accel) {
      const dt = copy.time - prev.time;
      if (dt >= 0.005) {
        const a = (Math.hypot(copy.vx, copy.vy, copy.vz) - Math.hypot(prev.vx, prev.vy, prev.vz)) / dt;
        this.accel = Math.max(-ACCEL_CAP, Math.min(ACCEL_CAP, a));
      }
    }
    this.stats.accepted++;
    this.clearOffset(now);
    if (shown && last && s.epoch === last.epoch) {
      const raw = this.sample(now, this.tmp2, false)!;
      const dx = shown.x - raw.x, dy = shown.y - raw.y, dz = shown.z - raw.z;
      if (Math.hypot(dx, dy, dz) > this.opt.snapDistance) this.stats.snaps++;
      else {
        this.ox = dx; this.oy = dy; this.oz = dz;
        // off = shown * conj(raw)
        const [qx, qy, qz, qw] = qmul(shown.qx, shown.qy, shown.qz, shown.qw, -raw.qx, -raw.qy, -raw.qz, raw.qw);
        const sgn = qw < 0 ? -1 : 1;
        this.oqx = sgn * qx; this.oqy = sgn * qy; this.oqz = sgn * qz; this.oqw = sgn * qw;
      }
    } else if (last) this.stats.snaps++;
    return true;
  }

  // The car at relay time t, into `out` (also returned); null before the first state. smooth: include the
  // correction being blended out (what to draw and collide with); false: the bare prediction.
  sample(t: number, out: RemoteSample, smooth = true): RemoteSample | null {
    const b = this.buf, n = b.length;
    if (!n) return null;
    const newest = b[n - 1], o = this.opt;
    if (t >= newest.time) this.extrapolate(newest, t - newest.time, out);
    else if (t <= b[0].time) { copyState(b[0], out); out.extrapolated = 0; }
    else {
      let i = n - 2;
      while (i > 0 && b[i].time > t) i--;
      interpolate(b[i], b[i + 1], t, out);
      out.extrapolated = 0;
    }
    out.time = t;
    out.age = t - newest.time;
    out.alpha = out.age <= o.fadeStart ? 1 : out.age >= o.fadeEnd ? 0 : 1 - (out.age - o.fadeStart) / (o.fadeEnd - o.fadeStart);
    out.collidable = out.age <= o.collideAge && !(newest.flags & STATE_FLAG.noCollide);
    out.correction = 0;
    if (smooth) {
      const k = Math.exp(-Math.max(0, t - this.offTime) / o.blendTau);
      if (k > 1e-4) {
        out.x += this.ox * k; out.y += this.oy * k; out.z += this.oz * k;
        out.correction = Math.hypot(this.ox, this.oy, this.oz) * k;
        // rotation offset scaled by k: nlerp from identity
        let ax = this.oqx * k, ay = this.oqy * k, az = this.oqz * k, aw = 1 - k + this.oqw * k;
        const m = Math.hypot(ax, ay, az, aw); ax /= m; ay /= m; az /= m; aw /= m;
        [out.qx, out.qy, out.qz, out.qw] = qmul(ax, ay, az, aw, out.qx, out.qy, out.qz, out.qw);
      }
    }
    return out;
  }

  reset() { this.buf.length = 0; this.clearOffset(0); this.accel = 0; }

  private clearOffset(t: number) {
    this.ox = this.oy = this.oz = 0; this.oqx = this.oqy = this.oqz = 0; this.oqw = 1; this.offTime = t;
  }

  private extrapolate(s: TimedState, dt: number, out: RemoteSample) {
    copyState(s, out);
    const T = Math.min(dt, this.opt.maxExtrapolate);
    out.extrapolated = T;
    if (T <= 0) return;
    const wx = s.wx, wy = s.wy, wz = s.wz, w = Math.hypot(wx, wy, wz);
    const speed = Math.hypot(s.vx, s.vy, s.vz);
    // speed change: never through zero (a braking car stops, it does not reverse)
    const a = speed > 0.5 ? this.accel : 0;
    const tStop = a < 0 ? speed / -a : Infinity;
    const scale = (tau: number) => (speed > 0 ? (speed + a * Math.min(tau, tStop)) / speed : 1);
    const steps = Math.max(1, Math.ceil(T / SUBSTEP)), h = T / steps;
    let px = s.x, py = s.y, pz = s.z;
    for (let i = 0; i < steps; i++) {
      const tau = (i + 0.5) * h, k = scale(tau);
      const [rx, ry, rz] = rotate(s.vx, s.vy, s.vz, wx, wy, wz, w, tau);
      px += rx * k * h; py += ry * k * h; pz += rz * k * h;
    }
    const [vx, vy, vz] = rotate(s.vx, s.vy, s.vz, wx, wy, wz, w, T), k = scale(T);
    out.x = px; out.y = py; out.z = pz; out.vx = vx * k; out.vy = vy * k; out.vz = vz * k;
    if (w > 1e-9) {
      const half = 0.5 * w * T, sn = Math.sin(half) / w;
      [out.qx, out.qy, out.qz, out.qw] = qmul(wx * sn, wy * sn, wz * sn, Math.cos(half), s.qx, s.qy, s.qz, s.qw);
    }
  }
}

function copyState(s: CarState, out: CarState) {
  out.x = s.x; out.y = s.y; out.z = s.z; out.qx = s.qx; out.qy = s.qy; out.qz = s.qz; out.qw = s.qw;
  out.vx = s.vx; out.vy = s.vy; out.vz = s.vz; out.wx = s.wx; out.wy = s.wy; out.wz = s.wz;
  out.steer = s.steer; out.throttle = s.throttle; out.brake = s.brake; out.gear = s.gear; out.rpm = s.rpm;
  out.flags = s.flags; out.epoch = s.epoch; out.compound = s.compound; out.reason = s.reason;
}

function interpolate(a: TimedState, b: TimedState, t: number, out: RemoteSample) {
  const span = b.time - a.time, u = (t - a.time) / span;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  const herm = (p0: number, v0: number, p1: number, v1: number) => h00 * p0 + h10 * span * v0 + h01 * p1 + h11 * span * v1;
  copyState(u < 0.5 ? a : b, out);   // discrete fields (gear, flags) from the nearer state
  out.x = herm(a.x, a.vx, b.x, b.vx); out.y = herm(a.y, a.vy, b.y, b.vy); out.z = herm(a.z, a.vz, b.z, b.vz);
  const lin = (p: number, q: number) => p + (q - p) * u;
  out.vx = lin(a.vx, b.vx); out.vy = lin(a.vy, b.vy); out.vz = lin(a.vz, b.vz);
  out.wx = lin(a.wx, b.wx); out.wy = lin(a.wy, b.wy); out.wz = lin(a.wz, b.wz);
  out.steer = lin(a.steer, b.steer); out.throttle = lin(a.throttle, b.throttle); out.brake = lin(a.brake, b.brake); out.rpm = lin(a.rpm, b.rpm);
  const sg = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw < 0 ? -1 : 1;
  let x = lin(a.qx, sg * b.qx), y = lin(a.qy, sg * b.qy), z = lin(a.qz, sg * b.qz), w = lin(a.qw, sg * b.qw);
  const m = Math.hypot(x, y, z, w); x /= m; y /= m; z /= m; w /= m;
  out.qx = x; out.qy = y; out.qz = z; out.qw = w;
}

// v rotated by angle |w| * t about w (Rodrigues).
function rotate(vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, w: number, t: number): [number, number, number] {
  if (w < 1e-9) return [vx, vy, vz];
  const kx = wx / w, ky = wy / w, kz = wz / w, th = w * t, c = Math.cos(th), s = Math.sin(th);
  const dot = kx * vx + ky * vy + kz * vz;
  const cx = ky * vz - kz * vy, cy = kz * vx - kx * vz, cz = kx * vy - ky * vx;
  return [vx * c + cx * s + kx * dot * (1 - c), vy * c + cy * s + ky * dot * (1 - c), vz * c + cz * s + kz * dot * (1 - c)];
}

function qmul(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): [number, number, number, number] {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
