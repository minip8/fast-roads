import * as THREE from 'three';
import { DT } from './config';
import type { Vehicle } from './vehicle';

// ============================================================================
// Ghost laps: the car's pose recorded through a lap (Timing runs a GhostRecorder), packed small for localStorage,
// and read back with interpolation for playback (ghostCar.ts draws it). No DOM, no rendering: Node tests use it.
//
// A recording is regular samples every GHOST_TICKS physics ticks, starting with the pose just before the line (the
// tick the lap started in begins there, at elapsed time t0 <= 0), and one last sample at the end of the tick the lap
// ended in (elapsed tEnd >= lapTime), so every time from 0 to the lap time lies between two samples.
//
// Packed format (little-endian), version 1:
//   u8 version, f64 lapTime, f64 t0, f64 h (sample spacing, s), f64 tEnd, u32 n, i32 x, y, z of sample 0 (cm),
//   then n samples of 11 bytes: i16 dx, dy, dz (cm, from the sample before; 0 for sample 0), i16 yaw (2^15 per pi),
//   i8 pitch, i8 roll (0.25 deg), i8 steer (0.01 rad).
// Quantisation: position 5 mm, yaw 0.003 deg, pitch and roll 0.125 deg, steer 0.005 rad (half a step each).
// Stored as base64 under the best-times key + GHOST_SUFFIX; it is only used if its lap time is the stored best lap.
// ============================================================================
export const GHOST_TICKS = 12;                   // physics ticks per sample (10 Hz)
export const GHOST_SUFFIX = '.ghost';
const VERSION = 1, HEADER = 49, SAMPLE = 11;
const MAX_SAMPLES = Math.round((30 * 60) / (GHOST_TICKS * DT));   // 30 minutes: a longer lap is not kept
const POS_Q = 100, YAW_Q = 32768 / Math.PI, TILT_Q = 180 / Math.PI / 0.25, STEER_Q = 100;
const STRIDE = 7;                                // recorder: x, y, z, yaw, pitch, roll, steer

const _e = new THREE.Euler(0, 0, 0, 'YXZ');

// Records one lap at a time: begin() at the line, tick() every physics tick after it, finish() at the line again.
export class GhostRecorder {
  private buf = new Float64Array(1200 * STRIDE);   // grows (doubling) for laps over 2 minutes
  n = 0;
  private j = 0;                                   // ticks since the first sample (the start of the tick the lap began in)
  private t0 = 0; private tEnd = 0; private lapTime = 0;
  private active = false; private overflow = false;

  // The lap started during the tick just run, `t0` (<= 0) seconds of lap time before its end: the car's previous
  // pose (where the tick began) is the first sample.
  begin(car: Vehicle, t0: number) {
    this.n = 0; this.j = 1; this.t0 = t0; this.active = true; this.overflow = false;
    this.push(car.prevPos, car.prevQuat, car.steer);
  }
  // Every tick, before the line crossings are looked at (so not in the tick begin() is called in).
  tick(car: Vehicle) {
    if (!this.active) return;
    if (++this.j % GHOST_TICKS === 0) this.push(car.pos, car.quat, car.steer);
  }
  // The lap ended in the tick just run: its last sample is the pose now, tEnd seconds into the lap.
  finish(car: Vehicle, tEnd: number, lapTime: number) {
    if (!this.active) return;
    this.active = false;
    if (this.j % GHOST_TICKS !== 0) this.push(car.pos, car.quat, car.steer);   // (else tick() just took it)
    this.tEnd = tEnd; this.lapTime = lapTime;
  }
  stop() { this.active = false; this.n = 0; }

  // The finished lap, packed (null if there is none, or it cannot be stored: too long, or a jump no lap makes).
  pack(): Uint8Array | null {
    const n = this.n, b = this.buf;
    if (this.active || this.overflow || n < 2) return null;
    const out = new Uint8Array(HEADER + n * SAMPLE), v = new DataView(out.buffer);
    v.setUint8(0, VERSION);
    v.setFloat64(1, this.lapTime, true); v.setFloat64(9, this.t0, true);
    v.setFloat64(17, GHOST_TICKS * DT, true); v.setFloat64(25, this.tEnd, true);
    v.setUint32(33, n, true);
    let px = Math.round(b[0] * POS_Q), py = Math.round(b[1] * POS_Q), pz = Math.round(b[2] * POS_Q);
    v.setInt32(37, px, true); v.setInt32(41, py, true); v.setInt32(45, pz, true);
    for (let i = 0; i < n; i++) {
      const k = i * STRIDE, o = HEADER + i * SAMPLE;
      const qx = Math.round(b[k] * POS_Q), qy = Math.round(b[k + 1] * POS_Q), qz = Math.round(b[k + 2] * POS_Q);
      const dx = qx - px, dy = qy - py, dz = qz - pz;
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) > 32767 || !Number.isFinite(dx + dy + dz)) return null;
      px = qx; py = qy; pz = qz;
      v.setInt16(o, dx, true); v.setInt16(o + 2, dy, true); v.setInt16(o + 4, dz, true);
      v.setInt16(o + 6, ((Math.round(b[k + 3] * YAW_Q) % 65536) + 98304) % 65536 - 32768, true);
      v.setInt8(o + 8, clampI8(b[k + 4] * TILT_Q)); v.setInt8(o + 9, clampI8(b[k + 5] * TILT_Q));
      v.setInt8(o + 10, clampI8(b[k + 6] * STEER_Q));
    }
    return out;
  }

  private push(p: THREE.Vector3, q: THREE.Quaternion, steer: number) {
    if (this.n >= MAX_SAMPLES) { this.overflow = true; return; }
    if ((this.n + 1) * STRIDE > this.buf.length) {   // once per 2 minutes of lap beyond the first
      const grown = new Float64Array(this.buf.length * 2); grown.set(this.buf); this.buf = grown;
    }
    _e.setFromQuaternion(q, 'YXZ');
    const k = this.n++ * STRIDE, b = this.buf;
    b[k] = p.x; b[k + 1] = p.y; b[k + 2] = p.z; b[k + 3] = _e.y; b[k + 4] = _e.x; b[k + 5] = _e.z; b[k + 6] = steer;
  }
}
const clampI8 = (v: number) => Math.max(-127, Math.min(127, Math.round(Number.isFinite(v) ? v : 0)));

// A recorded lap, ready to play back. Angles are in radians, yaw unwrapped (continuous); dist is the distance
// travelled from sample 0 (wheel spin).
export interface GhostLap {
  readonly lapTime: number; readonly t0: number; readonly h: number; readonly tEnd: number; readonly n: number;
  readonly x: Float64Array; readonly y: Float64Array; readonly z: Float64Array;
  readonly yaw: Float64Array; readonly pitch: Float64Array; readonly roll: Float64Array; readonly steer: Float64Array;
  readonly dist: Float64Array;
  readonly bytes: number;                        // packed size
}

// A packed lap read back, or null if it is not one (wrong version, truncated, inconsistent, non-finite).
export function unpackGhost(data: Uint8Array): GhostLap | null {
  if (data.length < HEADER) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint8(0) !== VERSION) return null;
  const lapTime = v.getFloat64(1, true), t0 = v.getFloat64(9, true), h = v.getFloat64(17, true), tEnd = v.getFloat64(25, true);
  const n = v.getUint32(33, true);
  if (![lapTime, t0, h, tEnd].every(Number.isFinite) || !(h > 0 && h <= 1) || lapTime <= 0) return null;
  if (n < 2 || n > MAX_SAMPLES || data.length !== HEADER + n * SAMPLE) return null;
  const lastGrid = t0 + (n - 2) * h;               // the last regular sample before the end one
  if (!(t0 <= 0 && t0 >= -h) || !(tEnd > lastGrid && tEnd <= lastGrid + h + 1e-6) || !(lapTime <= tEnd && lapTime >= tEnd - h)) return null;
  const f = () => new Float64Array(n);
  const g = { lapTime, t0, h, tEnd, n, x: f(), y: f(), z: f(), yaw: f(), pitch: f(), roll: f(), steer: f(), dist: f(), bytes: data.length };
  let px = v.getInt32(37, true), py = v.getInt32(41, true), pz = v.getInt32(45, true), yaw = 0;
  for (let i = 0; i < n; i++) {
    const o = HEADER + i * SAMPLE;
    px += v.getInt16(o, true); py += v.getInt16(o + 2, true); pz += v.getInt16(o + 4, true);
    g.x[i] = px / POS_Q; g.y[i] = py / POS_Q; g.z[i] = pz / POS_Q;
    const a = v.getInt16(o + 6, true) / YAW_Q;
    yaw = i ? yaw + wrapPi(a - yaw) : a;
    g.yaw[i] = yaw; g.pitch[i] = v.getInt8(o + 8) / TILT_Q; g.roll[i] = v.getInt8(o + 9) / TILT_Q; g.steer[i] = v.getInt8(o + 10) / STEER_Q;
    g.dist[i] = i ? g.dist[i - 1] + Math.hypot(g.x[i] - g.x[i - 1], g.y[i] - g.y[i - 1], g.z[i] - g.z[i - 1]) : 0;
  }
  return g;
}
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// The pose `t` seconds into the lap (clamped to the recording): position by cubic Hermite through the samples
// (tangents from the neighbours, so the path is smooth through corners), angles, steer and distance linearly.
export interface GhostPose { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; steer: number; dist: number }
export function ghostPose(g: GhostLap, t: number, out: GhostPose): GhostPose {
  const n = g.n, i = Math.max(0, Math.min(n - 2, Math.floor((t - g.t0) / g.h)));
  const i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, i + 2);
  const t0 = sampleTime(g, i0), ta = sampleTime(g, i), tb = sampleTime(g, i + 1), t3 = sampleTime(g, i3);
  const span = tb - ta, u = Math.max(0, Math.min(1, (t - ta) / span));
  out.x = hermite(g.x, i0, i, i3, t0, ta, tb, t3, u); out.y = hermite(g.y, i0, i, i3, t0, ta, tb, t3, u); out.z = hermite(g.z, i0, i, i3, t0, ta, tb, t3, u);
  out.yaw = lin(g.yaw, i, u); out.pitch = lin(g.pitch, i, u); out.roll = lin(g.roll, i, u); out.steer = lin(g.steer, i, u); out.dist = lin(g.dist, i, u);
  return out;
}
const sampleTime = (g: GhostLap, k: number) => (k >= g.n - 1 ? g.tEnd : g.t0 + k * g.h);
const lin = (p: Float64Array, i: number, u: number) => p[i] + (p[i + 1] - p[i]) * u;
// Between samples i and i + 1 (times ta, tb) with the tangents through their neighbours i0 and i3.
function hermite(p: Float64Array, i0: number, i: number, i3: number, t0: number, ta: number, tb: number, t3: number, u: number) {
  const span = tb - ta, m1 = (p[i + 1] - p[i0]) / (tb - t0), m2 = (p[i3] - p[i]) / (t3 - ta);
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p[i] + (u3 - 2 * u2 + u) * span * m1 + (-2 * u3 + 3 * u2) * p[i + 1] + (u3 - u2) * span * m2;
}

// ---------------- Storage ----------------
function toBase64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x4000) s += String.fromCharCode(...b.subarray(i, i + 0x4000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s), b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  } catch { return null; }
}

// The saved ghost for a best-times key, if it is readable and is the recording of `bestLap`.
export function loadGhost(storeKey: string, bestLap: number | null): GhostLap | null {
  if (bestLap == null) return null;
  try {
    const raw = localStorage.getItem(storeKey + GHOST_SUFFIX);
    const bytes = raw ? fromBase64(raw) : null, g = bytes && unpackGhost(bytes);
    return g && g.lapTime === bestLap ? g : null;
  } catch { return null; }
}
// Saves a packed lap (null: removes the old one). Returns false if storage refused it (quota), in which case no
// ghost is left saved for the key: the best times are saved separately, first, so they never depend on this.
export function saveGhost(storeKey: string, data: Uint8Array | null): boolean {
  const key = storeKey + GHOST_SUFFIX;
  try {
    localStorage.removeItem(key);   // the old one is stale anyway, and its room may be what the new one needs
    if (data) localStorage.setItem(key, toBase64(data));
    return true;
  } catch {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
    return false;
  }
}
