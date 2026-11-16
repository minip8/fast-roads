import type { AnyCarSpec, CarId, CarInfo } from '../cars';
import type { Track, TrackPos } from '../track';
import type { Vehicle } from '../vehicle';
import type { ObsConfig } from './config';

// ============================================================================
// The RL observation: a flat Float32 vector, track-relative so that one policy can drive any circuit and car. A pure
// function of the car (read only through Vehicle), the track's arrays and the controller state the environment
// passes in: no Node or DOM APIs, so the browser can build the same vector for inference. Every element is
// raw value x scale (after the transform, if one is named), then clipped to +-OBS_CLIP; observationSpec lists them all.
// ============================================================================
export const OBS_VERSION = 1;
export const OBS_CLIP = 10;
export const CAR_IDS: readonly CarId[] = ['lcf1', 'lcgt3', 'drift'];   // the one-hot's order
export const CURV_REF_M = 50;   // look-ahead curvature: sign(k) sqrt(|k| x CURV_REF_M), so a 50 m radius reads 1
const SLIP_PEAK = 1.15;         // VehicleWheel.slip at the tyre's grip peak
const WALL_FAR_M = 50;          // a wall further than this (or none) reads as this far
const WHEELS = ['fl', 'fr', 'rl', 'rr'] as const;
const SURFS = ['asphalt', 'kerb', 'grass', 'gravel'] as const;

export interface ObsEntry {
  name: string; index: number;
  scale: number;                 // element = transform(raw) x scale
  transform?: 'signed_sqrt_curvature' | 'one_hot' | 'flag';
  unit: string;                  // the raw value's unit
  desc: string;
}

// What the environment adds to the car's own state.
export interface ObsControl {
  steerLock: number;             // the car's full road-wheel lock (rad): steering commands are shares of it
  targetSteer: number; targetPedal: number;   // the command the actions ask for (delta mode: integrated), -1..1
  cmdSteer: number; cmdPedal: number;         // the command sent in the last tick (after the slew limits)
  prevSteer: number; prevPedal: number;       // the last action as given (delta mode: the deltas)
  wallContact: boolean; wallHit: number;      // over the last step
}

// The car's full road-wheel lock (rad), on either engine.
export function steerLockOf(info: CarInfo): number {
  const spec = info as AnyCarSpec;
  return spec.physics === 'lc' ? (spec.config.chassis.maxRoadWheelDeg * Math.PI) / 180 : spec.steerLock;
}

export function observationSpec(cfg: ObsConfig): ObsEntry[] {
  const out: ObsEntry[] = [];
  const add = (name: string, scale: number, unit: string, desc: string, transform?: ObsEntry['transform']) =>
    out.push({ name, index: out.length, scale, unit, desc, ...(transform ? { transform } : {}) });
  for (const id of CAR_IDS) add(`car_${id}`, 1, '', `car identity one-hot: ${id}`, 'one_hot');
  add('speed_fwd', 1 / 100, 'm/s', 'velocity along the car\'s nose');
  add('speed_lat', 1 / 20, 'm/s', 'velocity to the car\'s left');
  add('yaw_rate', 1 / 2, 'rad/s', 'yaw rate, + = turning left');
  add('slip_angle', 2, 'rad', 'body slip: atan2(speed_lat, max(|speed_fwd|, 3))');
  add('up_y', 1, '', 'vertical component of the car\'s up axis (1 upright, <0 on its roof)');
  add('lat_norm', 1, '', 'lateral offset from the centreline over the half-width on that side (+-1 at the edges, + = left)');
  add('heading_sin', 1, '', 'sin of the heading error to the track tangent (+ = nose left of the racing direction)');
  add('heading_cos', 1, '', 'cos of the heading error (< 0: facing the wrong way)');
  add('edge_left', 1 / 10, 'm', 'distance from the car\'s centre to the left track edge (< 0 past it)');
  add('edge_right', 1 / 10, 'm', 'distance from the car\'s centre to the right track edge (< 0 past it)');
  add('wall_left', 1 / 10, 'm', `distance from the car's centre to the left wall's face (${WALL_FAR_M} if none or further)`);
  add('wall_right', 1 / 10, 'm', `distance from the car's centre to the right wall's face (${WALL_FAR_M} if none or further)`);
  add('off_track', 1, '', 'all four wheels past the track limits (the game\'s definition: the lap is invalid)', 'flag');
  for (const w of WHEELS) for (const s of SURFS) add(`wheel_${w}_${s}`, 1, '', `wheel ${w.toUpperCase()} on ${s}`, 'one_hot');
  for (const w of WHEELS) add(`wheel_${w}_out`, 1, '', `wheel ${w.toUpperCase()} past the track limit`, 'flag');
  for (const w of WHEELS) add(`wheel_${w}_slip`, 1 / SLIP_PEAK, '', `wheel ${w.toUpperCase()} combined slip (1 = at the grip peak)`);
  add('gear', 1 / 8, '', 'gear (-1 reverse, 1.. forward)');
  add('rpm', 1, 'share', 'engine rpm over the redline');
  add('throttle', 1, '', 'throttle the engine got in the last tick (after the aids), 0..1');
  add('brake', 1, '', 'brake the engine got in the last tick, 0..1');
  add('steer', 1, '', 'front road-wheel angle over the full lock, + = left');
  add('tc_active', 1, '', 'traction control cut in during the last tick', 'flag');
  add('abs_active', 1, '', 'ABS cut in during the last tick', 'flag');
  add('target_steer', 1, '', 'steering command the actions ask for, share of full lock (+ = left)');
  add('target_pedal', 1, '', 'pedal command the actions ask for (+ throttle, - brake)');
  add('cmd_steer', 1, '', 'steering command sent in the last tick (after the slew limit)');
  add('cmd_pedal', 1, '', 'pedal command sent in the last tick (after the slew limit)');
  add('prev_steer', 1, '', 'last steering action as given');
  add('prev_pedal', 1, '', 'last pedal action as given');
  add('wall_contact', 1, '', 'touched a wall during the last step', 'flag');
  add('wall_hit', 1 / 10, 'm/s', 'hardest impact speed into a wall during the last step');
  add('look_reach', 1 / 400, 'm', `distance to the furthest look-ahead sample: lookMinM + lookSecs x max(speed_fwd, 0)`);
  for (let k = 0; k < cfg.lookahead; k++) {
    const at = `look-ahead sample ${k} (at look_reach x (${k + 1}/${cfg.lookahead})^lookPow along the centreline)`;
    add(`look${k}_curv`, 1, '1/m', `${at}: curvature, + = left, as sign(k) sqrt(|k| x ${CURV_REF_M})`, 'signed_sqrt_curvature');
    add(`look${k}_wl`, 1 / 10, 'm', `${at}: half-width to the left edge`);
    add(`look${k}_wr`, 1 / 10, 'm', `${at}: half-width to the right edge`);
    add(`look${k}_sin`, 1, '', `${at}: sin of the bearing of the centreline point from the car's nose (+ = left)`);
    add(`look${k}_cos`, 1, '', `${at}: cos of that bearing`);
  }
  add('tyres_present', 1, '', 'the car models tyre temperatures (else the four below are 0)', 'flag');
  for (const w of WHEELS) add(`tyre_${w}_temp`, 1, '', `tyre ${w.toUpperCase()} carcass temperature: 0 at the bottom of the axle's working window, 1 at its top`);
  add('battery_present', 1, '', 'the car has a hybrid battery', 'flag');
  add('battery', 1, 'share', 'battery charge 0..1');
  add('flaps_fitted', 1, '', 'the car has movable wings', 'flag');
  add('flaps_open', 1, '', 'the wings are open', 'flag');
  return out;
}

// Index (wrapping) of the sample whose segment holds arc length s (0 <= s < L), searching forward from i.
function seek(tr: Track, s: number, i: number): number {
  for (let n = 0; n <= tr.N; n++) {
    if (tr.S[i] <= s && s < tr.S[i + 1]) return i;
    i = i + 1 >= tr.N ? 0 : i + 1;
  }
  return i;
}

// Writes the observation into `out` (length observationSpec(cfg).length); returns how many elements were written.
// p: where the car is on the track now (projectOnTrack after the last tick).
export function observe(out: Float32Array, car: Vehicle, tr: Track, p: TrackPos, ctl: ObsControl, cfg: ObsConfig): number {
  let n = 0;
  const put = (v: number) => { out[n++] = Number.isFinite(v) ? Math.max(-OBS_CLIP, Math.min(OBS_CLIP, v)) : 0; };
  const id = car.spec.id;
  for (const c of CAR_IDS) put(c === id ? 1 : 0);
  const vF = car.speedF, vL = car.vel.dot(car.left);
  put(vF / 100);
  put(vL / 20);
  put(car.angv.dot(car.up) / 2);
  put(Math.atan2(vL, Math.max(Math.abs(vF), 3)) * 2);
  put(car.up.y);
  const i = p.i, lat = p.lat, wl = tr.WL[i], wr = tr.WR[i];
  put(lat >= 0 ? lat / wl : lat / wr);
  // heading error: the nose's direction in the track's frame (tangent, left normal), in the ground plane
  const fx = car.fwd.x, fz = car.fwd.z, fl = Math.hypot(fx, fz) || 1;
  put((fx * tr.NX[i] + fz * tr.NZ[i]) / fl);
  put((fx * tr.TX[i] + fz * tr.TZ[i]) / fl);
  put((wl - lat) / 10);
  put((wr + lat) / 10);
  put((tr.barLValid[i] ? Math.min(WALL_FAR_M, tr.barL[i] - lat) : WALL_FAR_M) / 10);
  put((tr.barRValid[i] ? Math.min(WALL_FAR_M, tr.barR[i] + lat) : WALL_FAR_M) / 10);
  const W = car.wheels;
  put(W[0].out && W[1].out && W[2].out && W[3].out ? 1 : 0);
  for (let k = 0; k < 4; k++) for (let s = 0; s < 4; s++) put(W[k].surf === s ? 1 : 0);
  for (let k = 0; k < 4; k++) put(W[k].out ? 1 : 0);
  for (let k = 0; k < 4; k++) put(Math.min(4, W[k].slip / SLIP_PEAK));
  put(car.gear / 8);
  put(car.rpm / car.spec.redline);
  put(car.throttle);
  put(car.brake);
  put(car.steer / ctl.steerLock);
  put(car.tcActive ? 1 : 0);
  put(car.absActive ? 1 : 0);
  put(ctl.targetSteer); put(ctl.targetPedal);
  put(ctl.cmdSteer); put(ctl.cmdPedal);
  put(ctl.prevSteer); put(ctl.prevPedal);
  put(ctl.wallContact ? 1 : 0);
  put(ctl.wallHit / 10);
  // look-ahead along the centreline
  const reach = cfg.lookMinM + cfg.lookSecs * Math.max(0, vF);
  put(reach / 400);
  const L = tr.L, px = car.pos.x, pz = car.pos.z, lx = car.left.x, lz = car.left.z;
  let j = i;
  for (let k = 0; k < cfg.lookahead; k++) {
    const d = reach * Math.pow((k + 1) / cfg.lookahead, cfg.lookPow);
    let s = (p.s + d) % L;
    if (s < 0) s += L;
    j = seek(tr, s, j);
    const j2 = j + 1 >= tr.N ? 0 : j + 1, f = (s - tr.S[j]) / (tr.S[j + 1] - tr.S[j] || 1);
    const kk = tr.K[j] + (tr.K[j2] - tr.K[j]) * f;
    put(Math.sign(kk) * Math.sqrt(Math.abs(kk) * CURV_REF_M));
    put((tr.WL[j] + (tr.WL[j2] - tr.WL[j]) * f) / 10);
    put((tr.WR[j] + (tr.WR[j2] - tr.WR[j]) * f) / 10);
    const dx = tr.X[j] + (tr.X[j2] - tr.X[j]) * f - px, dz = tr.Z[j] + (tr.Z[j2] - tr.Z[j]) * f - pz;
    const a = dx * lx + dz * lz, b = dx * fx + dz * fz, r = Math.hypot(a, b) || 1;
    put(a / r);
    put(b / r);
  }
  const ty = car.tyres;
  put(ty ? 1 : 0);
  for (let k = 0; k < 4; k++) {
    if (!ty) { put(0); continue; }
    const [lo, hi] = ty.windowC[k < 2 ? 0 : 1];
    put((ty.wheels[k].coreC - lo) / (hi - lo || 1));
  }
  const bat = car.battery;
  put(bat === undefined ? 0 : 1);
  put(bat ?? 0);
  const flaps = car.flapsOpen;
  put(flaps === undefined ? 0 : 1);
  put(flaps ? 1 : 0);
  return n;
}
