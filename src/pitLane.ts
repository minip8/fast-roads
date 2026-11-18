import { KERB_W } from './config';
import type { Track } from './track';
import { clamp, lerp, wrapI } from './util';

// ============================================================================
// The pit lane: each circuit's real lane (tracks/pits/<id>.csv, from OpenStreetMap by scripts/tracks/pits.mjs) as
// part of the circuit, in every mode. Pure geometry, built once with the track (circuit.ts), no rendering
// (pitLaneMesh.ts draws it). A lane has its own path in world space (a real lane is not a strip beside the start
// straight: Silverstone's cuts 106 m inside Vale and Club), so everything that asks where a car is asks the lane
// itself (laneAt), not the track's lateral coordinate.
//
// The lane: a fast lane LANE.fast wide along the path, and along the working stretch (beside the garages:
// TrackDef.pit) a working lane LANE.work wide on its far side, where the box and one-shot qualifying's waiting spots
// are. It leaves the track at the entry (its first row, on the racing line) and rejoins at the exit (its last). From
// the pit wall's nose to its tail a pit wall stands between it and the track (its lane face along the fast lane's
// inner edge, LANE.wall thick, thinning to a point at each end over LANE.taper), and an outer wall along its far
// edge, so the only ways in and out are the openings at either end. The track's own barrier on the pit side becomes
// the pit wall's track face where the lane runs beside the track (attachPitLane), bends out round the lane at the
// openings, and is the barrier it was where the lane runs far from the track.
//
// Where the data puts the lane closer to the track than the pit wall and a gap allow (LANE.gap + LANE.wall + half
// the fast lane beyond the edge), the lane is moved out along the track's normal by as little as that takes,
// diverging from the track's edge by at least LANE.slope at each opening.
// ============================================================================
export const LANE = {
  fast: 6,            // m: the fast lane's width
  work: 5,            // m: the working lane beside it along the garages
  wall: 0.5,          // m: the pit wall's thickness (the track's barriers are drawn 0.5 m thick)
  gap: 1.5,           // m: the least from the track's edge to the pit wall's track face (a kerb's width and a little)
  slope: 0.125,       // the least the lane diverges from the track's edge at an opening (1 in 8, about 7 deg)
  taper: 12,          // m over which the pit wall thickens from its nose (and thins to its tail)
  step: 2,            // m between the path's samples
  limitKmh: 80,       // the speed limit between the limit lines (the rules: weekend.ts)
  workRamp: 15,       // m over which the working lane widens in and out
  outerWall: 0.5,     // m: the outer wall's thickness
} as const;

export interface LaneRow { x: number; z: number; s: number; lat: number }

// A circuit's pit lane CSV (tracks/pits/<id>.csv): x, y (north: world -z), s and lat on our centreline.
export function parsePitCsv(text: string): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const [x, y, s, lat] = t.split(',').map(Number);
    if ([x, y, s, lat].some((v) => !isFinite(v))) continue;
    rows.push({ x, z: -y, s, lat });
  }
  return rows;
}

// What the lane needs from the circuit's definition.
export interface LaneOptions {
  side: 1 | -1;                       // TrackDef.pitSide: the lane's side of the track (+1 left)
  work: [from: number, to: number];   // TrackDef.pit: the working stretch, m from the line along the lap
  sScale: number;                     // our lap length / the CSV centreline's (the rows' s are the CSV's metres)
  cut?: { at: number; merge: number };   // keep the lane to `at` m along it, then merge onto the track over `merge` m
}

// A wall: a polyline (x, z pairs).
export type Polyline = Float64Array;

export interface PitLane {
  readonly side: 1 | -1;
  readonly n: number;                 // samples along the path, LANE.step apart
  readonly X: Float64Array; readonly Z: Float64Array;      // the path: the fast lane's middle
  readonly TX: Float64Array; readonly TZ: Float64Array;    // unit tangent
  readonly NX: Float64Array; readonly NZ: Float64Array;    // unit normal pointing left (as the track's)
  readonly D: Float64Array;           // m along the path
  readonly len: number;
  readonly wIn: Float64Array;         // m from the path to the road's edge on the track's side (the gore at the openings)
  readonly wOut: Float64Array;        // m from the path to the road's far edge (the working lane included)
  readonly S: Float64Array;           // lap position (m from the line) at each sample, unwrapped: increasing, may pass L
  readonly I: Int32Array;             // its own stretch's track sample
  readonly sep: Float64Array;         // m the path is beyond the track's edge there (negative: on the road)
  readonly sStart: number;            // S[0] in 0..L
  readonly nose: number; readonly tail: number;    // m along: the pit wall's ends (the openings are before and after)
  readonly kNose: number; readonly kTail: number;  // ...their samples
  readonly limIn: number; readonly limOut: number; // m along: the limit lines
  readonly work: readonly [number, number];         // m along: the working stretch
  readonly box: number;               // m along: the box's middle
  readonly boxOff: number;            // m from the path towards the far side: the box's middle (in the working lane)
  readonly limitMs: number;           // the speed limit (m/s) between the limit lines
  readonly moved: number;             // the most it was moved out from the data's path (m)
  // walls (x, z polylines): the pit wall's lane face and track face (meeting at the nose and the tail), the far wall
  readonly walls: { lane: Polyline; track: Polyline; outer: Polyline; joins: Polyline[] };
  // the pit building (from the working stretch): centre, its axis along, half length, depth, the side its front faces
  readonly building: { x: number; z: number; ax: number; az: number; halfLen: number; depth: number; nx: number; nz: number } | null;
  readonly grid: LaneGrid;
}

// ---------------------------------------------------------------------------- building
const smoothstep = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

// The lap's length of the CSV centreline (closed polyline of its rows): the rows' s are in its metres.
export function csvLapLength(pts: { x: number; z: number }[]): number {
  let L = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; L += Math.hypot(b.x - a.x, b.z - a.z); }
  return L;
}

// The rows as a smooth path every LANE.step m, with each point's lap position (the rows' s, scaled, unwrapped).
function resample(tr: Track, rows: LaneRow[], sScale: number) {
  const L = tr.L, n = rows.length;
  const su: number[] = [];
  for (let j = 0, wraps = 0; j < n; j++) {
    if (j > 0 && rows[j].s < rows[j - 1].s - L / 2 / sScale) wraps++;
    su.push((rows[j].s + wraps * (L / sScale)) * sScale);
  }
  // Catmull-Rom through the rows (ends clamped), 5 points per row gap
  const dx: number[] = [], dz: number[] = [], ds: number[] = [];
  const at = (j: number) => rows[clamp(j, 0, n - 1)];
  for (let j = 0; j < n - 1; j++) {
    const p0 = at(j - 1), p1 = at(j), p2 = at(j + 1), p3 = at(j + 2);
    for (let q = 0; q < 5; q++) {
      const t = q / 5, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dx.push(cr(p0.x, p1.x, p2.x, p3.x)); dz.push(cr(p0.z, p1.z, p2.z, p3.z)); ds.push(lerp(su[j], su[j + 1], t));
    }
  }
  dx.push(rows[n - 1].x); dz.push(rows[n - 1].z); ds.push(su[n - 1]);
  const m = dx.length, cum = new Float64Array(m);
  for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + Math.hypot(dx[k] - dx[k - 1], dz[k] - dz[k - 1]);
  const total = cum[m - 1], cnt = Math.max(2, Math.round(total / LANE.step) + 1);
  const X = new Float64Array(cnt), Z = new Float64Array(cnt), S = new Float64Array(cnt);
  for (let k = 0, j = 0; k < cnt; k++) {
    const d = (k * total) / (cnt - 1);
    while (j < m - 2 && cum[j + 1] < d) j++;
    const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    X[k] = lerp(dx[j], dx[j + 1], f); Z[k] = lerp(dz[j], dz[j + 1], f); S[k] = lerp(ds[j], ds[j + 1], f);
  }
  smoothOpen(X, 3, 3); smoothOpen(Z, 3, 3);
  return { X, Z, S };
}

// A moving average over r samples either side, the ends kept (fewer samples there).
function smoothOpen(a: Float64Array, r: number, passes: number) {
  const n = a.length;
  for (let p = 0; p < passes; p++) {
    const src = Float64Array.from(a);
    for (let k = 1; k < n - 1; k++) {
      const h = Math.min(r, k, n - 1 - k);
      let sum = 0;
      for (let j = -h; j <= h; j++) sum += src[k + j];
      a[k] = sum / (2 * h + 1);
    }
  }
}

// Tangents, normals and distances of a path.
function frame(X: Float64Array, Z: Float64Array) {
  const n = X.length, TX = new Float64Array(n), TZ = new Float64Array(n), NX = new Float64Array(n), NZ = new Float64Array(n), D = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
    let tx = X[b] - X[a], tz = Z[b] - Z[a];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    TX[k] = tx; TZ[k] = tz; NX[k] = tz; NZ[k] = -tx;
    if (k > 0) D[k] = D[k - 1] + Math.hypot(X[k] - X[k - 1], Z[k] - Z[k - 1]);
  }
  return { TX, TZ, NX, NZ, D };
}

// The track sample nearest (x, z) within `r` samples of i.
function nearSample(tr: Track, x: number, z: number, i: number, r: number) {
  let best = wrapI(i, tr.N), bd = Infinity;
  for (let k = -r; k <= r; k++) {
    const j = wrapI(i + k, tr.N), dx = x - tr.X[j], dz = z - tr.Z[j], d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

// Each sample's own track sample and how far it is beyond the track's edge on the lane's side.
function ownStretch(tr: Track, X: Float64Array, Z: Float64Array, S: Float64Array, side: 1 | -1) {
  const n = X.length, I = new Int32Array(n), sep = new Float64Array(n), edge = side > 0 ? tr.WL : tr.WR;
  for (let k = 0; k < n; k++) {
    const i = nearSample(tr, X[k], Z[k], Math.round((S[k] / tr.L) * tr.N), 8);
    I[k] = i;
    sep[k] = side * ((X[k] - tr.X[i]) * tr.NX[i] + (Z[k] - tr.Z[i]) * tr.NZ[i]) - edge[i];
  }
  return { I, sep };
}

// The lane from its rows. Throws if the rows do not make a lane that leaves and rejoins the track.
export function buildPitLane(tr: Track, rowsIn: LaneRow[], opt: LaneOptions): PitLane {
  const side = opt.side, half = LANE.fast / 2, req = LANE.gap + LANE.wall + half;
  let rows = rowsIn;
  if (opt.cut) rows = cutLane(tr, rows, opt.cut.at, opt.cut.merge, opt.sScale);
  let { X, Z, S } = resample(tr, rows, opt.sScale);
  const n = X.length;
  let { I, sep } = ownStretch(tr, X, Z, S, side);
  let { D } = frame(X, Z);
  // where the path crosses the track's edge going out and coming back
  let ein = sep.findIndex((v) => v >= 0), eout = n - 1;
  while (eout > 0 && sep[eout] < 0) eout--;
  if (ein < 0 || eout <= ein) throw new Error('the pit lane never leaves the track');
  // move the lane out where it is closer than the pit wall allows (ramping in at the openings)
  const push = new Float64Array(n);
  let moved = 0;
  for (let k = ein; k <= eout; k++) {
    const target = Math.min(req, LANE.slope * (D[k] - D[ein]), LANE.slope * (D[eout] - D[k]));
    push[k] = Math.max(0, target - sep[k]);
  }
  if (push.some((v) => v > 0)) {
    // (grown over 2w either side, then averaged over w twice: every sample keeps at least its own push)
    const w = 6, grown = new Float64Array(n);
    for (let k = 0; k < n; k++) { let v = 0; for (let j = Math.max(0, k - 2 * w); j <= Math.min(n - 1, k + 2 * w); j++) v = Math.max(v, push[j]); grown[k] = v; }
    for (let pass = 0; pass < 2; pass++) {
      const src = Float64Array.from(grown);
      for (let k = 0; k < n; k++) { let v = 0, c = 0; for (let j = Math.max(0, k - w); j <= Math.min(n - 1, k + w); j++) { v += src[j]; c++; } grown[k] = v / c; }
    }
    X = Float64Array.from(X); Z = Float64Array.from(Z);
    moved = Math.max(...grown);
    for (let k = 0; k < n; k++) {
      const i = I[k];
      X[k] += side * tr.NX[i] * grown[k]; Z[k] += side * tr.NZ[i] * grown[k];
    }
    smoothOpen(X, 2, 2); smoothOpen(Z, 2, 2);
    ({ I, sep } = ownStretch(tr, X, Z, S, side));
    ({ D } = frame(X, Z));
    ein = sep.findIndex((v) => v >= 0); eout = n - 1;
    while (eout > 0 && sep[eout] < 0) eout--;
  }
  const { TX, TZ, NX, NZ } = frame(X, Z), len = D[n - 1];
  // the pit wall's ends: where the lane is first and last far enough out for it
  let kn = ein; while (kn < eout && sep[kn] < req - 0.05) kn++;
  let kt = eout; while (kt > kn && sep[kt] < req - 0.05) kt--;
  if (kt - kn < 20) throw new Error('the pit lane is never clear of the track');
  const nose = D[kn], tail = D[kt];
  // the working stretch (TrackDef.pit) along the lane, clear of the pit wall's ends; the limit lines round it
  const L = tr.L, lapAt = (s: number) => { // m along the lane where its lap position passes s (m from the line)
    const s0 = S[0];
    let t = ((s - s0) % L + L) % L + s0;
    if (t > S[n - 1]) t = t - S[n - 1] < s0 + L - t ? S[n - 1] : s0;   // (beyond the lane: its nearer end)
    let k = 0; while (k < n - 2 && S[k + 1] < t) k++;
    return lerp(D[k], D[k + 1], clamp((t - S[k]) / (S[k + 1] - S[k] || 1), 0, 1));
  };
  let w0 = lapAt(opt.work[0]), w1 = lapAt(opt.work[1]);
  const limIn = Math.max(nose + 25, Math.min(w0 - 60, tail - 200)), limOut = Math.min(tail - 25, Math.max(w1 + 60, limIn + 150));
  w0 = clamp(w0, limIn + 20, limOut - 60); w1 = clamp(w1, w0 + 40, limOut - 20);
  // widths: the fast lane, the working lane, the gore (to the track's edge and kerb) at the openings
  const kerb = side > 0 ? tr.kerbL : tr.kerbR;
  const wIn = new Float64Array(n), wOut = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    wIn[k] = k < kn || k > kt ? Math.max(half, sep[k] - (kerb[I[k]] ? KERB_W : 0)) : half;
    const r = Math.min(smoothstep((D[k] - w0 + LANE.workRamp) / LANE.workRamp), smoothstep((w1 + LANE.workRamp - D[k]) / LANE.workRamp));
    wOut[k] = half + LANE.work * r;
  }
  const box = (w0 + w1) / 2, boxOff = half + LANE.work / 2;
  // walls
  const laneFace: number[] = [], trackFace: number[] = [], outer: number[] = [];
  for (let k = kn; k <= kt; k++) {
    const t = LANE.wall * Math.min(1, (D[k] - nose) / LANE.taper, (tail - D[k]) / LANE.taper);
    const ox = -side * NX[k], oz = -side * NZ[k];   // towards the track
    laneFace.push(X[k] + ox * half, Z[k] + oz * half);
    trackFace.push(X[k] + ox * (half + t), Z[k] + oz * (half + t));
  }
  for (let k = kn; k <= kt; k++) outer.push(X[k] + side * NX[k] * wOut[k], Z[k] + side * NZ[k] * wOut[k]);
  const lane: PitLane = {
    side, n, X, Z, TX, TZ, NX, NZ, D, len, wIn, wOut, S, I, sep, sStart: ((S[0] % L) + L) % L,
    nose, tail, kNose: kn, kTail: kt, limIn, limOut, work: [w0, w1], box, boxOff, limitMs: LANE.limitKmh / 3.6, moved,
    walls: { lane: Float64Array.from(laneFace), track: Float64Array.from(trackFace), outer: Float64Array.from(outer), joins: [] },
    building: null, grid: null as unknown as LaneGrid,
  };
  (lane as { grid: LaneGrid }).grid = buildGrid(lane);
  return lane;
}

// The pit building: 12 m deep, 1 m beyond the working lane's far wall, along the chord of the working stretch,
// shortened from its ends (or left out, under 40 m) where it would reach any part of the circuit (a road and its
// barriers) or the lane.
export const BUILDING_DEPTH = 12;
function buildingOf(tr: Track, l: PitLane): PitLane['building'] {
  for (let d0 = l.work[0], d1 = l.work[1]; d1 - d0 >= 40; d0 += 4, d1 -= 4) {
    const b = buildingBetween(l, sampleAt(l, d0), sampleAt(l, d1));
    if (!b) return null;
    const pts: [number, number][] = [];
    for (let u = -b.halfLen; u <= b.halfLen + 1e-6; u += Math.max(1, b.halfLen / 12)) {
      for (const v of [-b.depth / 2, 0, b.depth / 2]) pts.push([b.x + b.ax * u + b.nx * v, b.z + b.az * u + b.nz * v]);
    }
    const p: LanePos = { d: 0, off: 0, k: 0 };
    if (pts.every(([x, z]) => clearOfTrack(tr, x, z, 0.5) && !laneAt(l, x, z, p))) return b;
  }
  return null;
}

// Whether (x, z) is outside every stretch's barriers (beside a centreline sample, farther than its barrier + margin;
// where a side has no barrier, its edge + 7 m), anywhere round the lap.
export function clearOfTrack(tr: Track, x: number, z: number, margin: number): boolean {
  for (let j = 0; j < tr.N; j++) {
    const dx = x - tr.X[j], dz = z - tr.Z[j];
    if (dx * dx + dz * dz > 3600 || Math.abs(dx * tr.TX[j] + dz * tr.TZ[j]) > 1.5) continue;
    const lat = dx * tr.NX[j] + dz * tr.NZ[j], left = lat > 0;
    const bar = (left ? tr.barLValid : tr.barRValid)[j] ? (left ? tr.barL : tr.barR)[j] : (left ? tr.WL : tr.WR)[j] + 7;
    if (Math.abs(lat) < bar + margin) return false;
  }
  return true;
}

function buildingBetween(l: PitLane, k0: number, k1: number): PitLane['building'] {
  const ax0 = l.X[k1] - l.X[k0], az0 = l.Z[k1] - l.Z[k0], len = Math.hypot(ax0, az0);
  if (len < 30) return null;
  const ax = ax0 / len, az = az0 / len;
  // outward: the chord's normal on the lane's far side; the front 1 m beyond the farthest point of the far edge
  const nx = l.side * az, nz = -l.side * ax;
  let front = -Infinity;
  for (let k = k0; k <= k1; k++) {
    const ex = l.X[k] + l.side * l.NX[k] * l.wOut[k], ez = l.Z[k] + l.side * l.NZ[k] * l.wOut[k];
    front = Math.max(front, (ex - l.X[k0]) * nx + (ez - l.Z[k0]) * nz);
  }
  const off = front + LANE.outerWall + 1 + BUILDING_DEPTH / 2, mx = (l.X[k0] + l.X[k1]) / 2, mz = (l.Z[k0] + l.Z[k1]) / 2;
  const base = (mx - l.X[k0]) * nx + (mz - l.Z[k0]) * nz;
  return { x: mx + nx * (off - base), z: mz + nz * (off - base), ax, az, halfLen: len / 2, depth: BUILDING_DEPTH, nx: -nx, nz: -nz };
}

// The sample nearest d m along the lane.
export function sampleAt(l: PitLane, d: number): number {
  return clamp(Math.round((d / l.len) * (l.n - 1)), 0, l.n - 1);
}
// The point d m along the lane, `off` m from its path (+ towards the far side).
export function lanePoint(l: PitLane, d: number, off = 0): { x: number; z: number; tx: number; tz: number } {
  const f = clamp(d / l.len, 0, 1) * (l.n - 1), k = Math.min(l.n - 2, Math.floor(f)), t = f - k;
  const nx = lerp(l.NX[k], l.NX[k + 1], t), nz = lerp(l.NZ[k], l.NZ[k + 1], t);
  return {
    x: lerp(l.X[k], l.X[k + 1], t) + l.side * nx * off, z: lerp(l.Z[k], l.Z[k + 1], t) + l.side * nz * off,
    tx: lerp(l.TX[k], l.TX[k + 1], t), tz: lerp(l.TZ[k], l.TZ[k + 1], t),
  };
}
// The lap position (m from the line, 0..L) d m along the lane.
export function laneLapS(l: PitLane, L: number, d: number): number {
  const f = clamp(d / l.len, 0, 1) * (l.n - 1), k = Math.min(l.n - 2, Math.floor(f));
  const s = lerp(l.S[k], l.S[k + 1], f - k);
  return ((s % L) + L) % L;
}

// Keep the lane's rows to `at` m along it, then merge onto the track's racing line on the lane's side over `merge` m:
// for a lane whose real exit is unusable here (Yas Marina's passes under the track in a tunnel; this world is flat).
function cutLane(tr: Track, rows: LaneRow[], at: number, merge: number, sScale: number): LaneRow[] {
  const out: LaneRow[] = [rows[0]];
  let d = 0, j = 1;
  for (; j < rows.length; j++) {
    d += Math.hypot(rows[j].x - rows[j - 1].x, rows[j].z - rows[j - 1].z);
    if (d > at) break;
    out.push(rows[j]);
  }
  const last = out[out.length - 1], L = tr.L, s0 = last.s * sScale;
  const i0 = nearSample(tr, last.x, last.z, Math.round((s0 / L) * tr.N), 8);
  const lat0 = (last.x - tr.X[i0]) * tr.NX[i0] + (last.z - tr.Z[i0]) * tr.NZ[i0];
  for (let m = 5; m <= merge; m += 5) {
    const s = tr.S[i0] + m, f = smoothstep(m / merge), i = wrapI(Math.round(((s % L) / L) * tr.N), tr.N), lat = lat0 * (1 - f);
    out.push({ x: tr.X[i] + tr.NX[i] * lat, z: tr.Z[i] + tr.NZ[i] * lat, s: ((s % L) + L) % L / sScale, lat });
  }
  return out;
}

// ---------------------------------------------------------------------------- where a point is
// A uniform grid of the path's segments: segment k (samples k, k+1) is listed in every cell its slab (with the walls
// and LANE.reach to spare) overlaps.
const CELL = 8;
const REACH = 4;   // m beyond the walls a segment's cells cover (footprint queries may look a little further)
export interface LaneGrid { minX: number; minZ: number; nx: number; nz: number; start: Uint32Array; items: Uint32Array }
const cellOf = (v: number, min: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((v - min) / CELL)));

function buildGrid(l: PitLane): LaneGrid {
  const pad = (k: number) => Math.max(l.wIn[k], l.wOut[k]) + LANE.wall + LANE.outerWall + REACH;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < l.n; k++) {
    const p = pad(k);
    minX = Math.min(minX, l.X[k] - p); maxX = Math.max(maxX, l.X[k] + p); minZ = Math.min(minZ, l.Z[k] - p); maxZ = Math.max(maxZ, l.Z[k] + p);
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL)), nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
  const lists: number[][] = Array.from({ length: nx * nz }, () => []);
  for (let k = 0; k < l.n - 1; k++) {
    const p = Math.max(pad(k), pad(k + 1));
    const x0 = Math.min(l.X[k], l.X[k + 1]) - p, x1 = Math.max(l.X[k], l.X[k + 1]) + p;
    const z0 = Math.min(l.Z[k], l.Z[k + 1]) - p, z1 = Math.max(l.Z[k], l.Z[k + 1]) + p;
    for (let cz = cellOf(z0, minZ, nz); cz <= cellOf(z1, minZ, nz); cz++)
      for (let cx = cellOf(x0, minX, nx); cx <= cellOf(x1, minX, nx); cx++) lists[cz * nx + cx].push(k);
  }
  const start = new Uint32Array(nx * nz + 1);
  for (let c = 0; c < nx * nz; c++) start[c + 1] = start[c] + lists[c].length;
  const items = new Uint32Array(start[nx * nz]);
  for (let c = 0; c < nx * nz; c++) items.set(lists[c], start[c]);
  return { minX, minZ, nx, nz, start, items };
}

// Where (x, z) is along the lane: d (m along), off (m from the path, + towards the far side), k (segment).
export interface LanePos { d: number; off: number; k: number }

// The lane coordinates of (x, z) in segment k's slab (between the normals at k and k + 1), or false outside it.
function inSlab(l: PitLane, k: number, x: number, z: number, out: LanePos): boolean {
  const ua = (x - l.X[k]) * l.TX[k] + (z - l.Z[k]) * l.TZ[k];
  const ub = (x - l.X[k + 1]) * l.TX[k + 1] + (z - l.Z[k + 1]) * l.TZ[k + 1];
  if (ua < 0 && k > 0) return false;
  if (ub >= 0 && k < l.n - 2) return false;
  const f = ua - ub > 1e-9 ? clamp(ua / (ua - ub), 0, 1) : 0;
  const oa = (x - l.X[k]) * l.NX[k] + (z - l.Z[k]) * l.NZ[k], ob = (x - l.X[k + 1]) * l.NX[k + 1] + (z - l.Z[k + 1]) * l.NZ[k + 1];
  out.k = k;
  out.d = lerp(l.D[k], l.D[k + 1], f) + (k === 0 && ua < 0 ? ua : 0) + (k === l.n - 2 && ub > 0 ? ub : 0);
  out.off = l.side * lerp(oa, ob, f);
  return true;
}

// (x, z) on the lane's road (the gore at its openings included, from its first sample to its last): its lane
// coordinates in `out`. Stateless and cheap (a grid cell's few segments): the LibreCorsa engine asks it for every
// wheel every 2 ms.
export function laneAt(l: PitLane, x: number, z: number, out: LanePos): boolean {
  const g = l.grid;
  if (x < g.minX || z < g.minZ || x >= g.minX + g.nx * CELL || z >= g.minZ + g.nz * CELL) return false;
  const c = cellOf(z, g.minZ, g.nz) * g.nx + cellOf(x, g.minX, g.nx);
  for (let j = g.start[c], end = g.start[c + 1]; j < end; j++) {
    const k = g.items[j];
    if (!inSlab(l, k, x, z, out)) continue;
    if (out.d < 0 || out.d > l.len) continue;
    const f = clamp((out.d - l.D[k]) / (l.D[k + 1] - l.D[k] || 1), 0, 1);
    if (out.off >= -lerp(l.wIn[k], l.wIn[k + 1], f) && out.off <= lerp(l.wOut[k], l.wOut[k + 1], f)) return true;
  }
  return false;
}

// Whether (x, z) is on or inside the pit lane, its walls or its building, or within `margin` m of them: what scenery
// placed round the circuit must keep clear of. Cheap enough for thousands of calls at build (a grid lookup).
export function pitFootprint(l: PitLane, x: number, z: number, margin = 0): boolean {
  const b = l.building;
  if (b) {
    const dx = x - b.x, dz = z - b.z, u = dx * b.ax + dz * b.az, v = dx * b.nx + dz * b.nz;
    if (Math.abs(u) <= b.halfLen + margin && Math.abs(v) <= b.depth / 2 + margin) return true;
  }
  const g = l.grid, r = Math.min(margin, REACH), p: LanePos = { d: 0, off: 0, k: 0 };
  if (x < g.minX - r || z < g.minZ - r || x >= g.minX + g.nx * CELL + r || z >= g.minZ + g.nz * CELL + r) return false;
  for (let cz = cellOf(z - r, g.minZ, g.nz), cz1 = cellOf(z + r, g.minZ, g.nz); cz <= cz1; cz++) {
    for (let cx = cellOf(x - r, g.minX, g.nx), cx1 = cellOf(x + r, g.minX, g.nx); cx <= cx1; cx++) {
      const c = cz * g.nx + cx;
      for (let j = g.start[c], end = g.start[c + 1]; j < end; j++) {
        const k = g.items[j];
        if (!inSlab(l, k, x, z, p)) continue;
        if (p.d < -margin || p.d > l.len + margin) continue;
        const f = clamp((p.d - l.D[k]) / (l.D[k + 1] - l.D[k] || 1), 0, 1);
        const walled = p.d >= l.nose && p.d <= l.tail;
        const inner = lerp(l.wIn[k], l.wIn[k + 1], f) + (walled ? LANE.wall : 0), outer = lerp(l.wOut[k], l.wOut[k + 1], f) + (walled ? LANE.outerWall : 0);
        if (p.off >= -inner - margin && p.off <= outer + margin) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------- the track's barrier round the lane
// A ray from (ox, oz) along (dx, dz) against a polyline: the distance to the first crossing within maxT, or NaN, and
// the crossing's segment and fraction in hit.
function rayPolyline(ox: number, oz: number, dx: number, dz: number, pl: Polyline, maxT: number, hit?: { seg: number; f: number }): number {
  let best = Number.NaN;
  for (let j = 0; j + 3 < pl.length; j += 2) {
    const ax = pl[j], az = pl[j + 1], bx = pl[j + 2], bz = pl[j + 3];
    // quick reject: the segment's start farther than maxT + its length (in the L1 norm, with room)
    const sx = bx - ax, sz = bz - az, sl = Math.abs(sx) + Math.abs(sz);
    if (Math.abs(ax - ox) + Math.abs(az - oz) > 1.5 * (maxT + sl)) continue;
    const den = dx * sz - dz * sx;
    if (Math.abs(den) < 1e-12) continue;
    const qx = ax - ox, qz = az - oz;
    const t = (qx * sz - qz * sx) / den, u = (qx * dz - qz * dx) / den;
    if (t < 0 || t > maxT || u < 0 || u > 1) continue;
    if (!(t >= best)) { best = t; if (hit) { hit.seg = j / 2; hit.f = u; } }
  }
  return best;
}

// The road's edges as polylines (the far edge, the near edge with the gore), samples k0..k1.
export function edgeLine(l: PitLane, which: 'in' | 'out', k0 = 0, k1 = l.n - 1): Polyline {
  const out = new Float64Array((k1 - k0 + 1) * 2);
  for (let k = k0; k <= k1; k++) {
    const o = which === 'out' ? l.side * l.wOut[k] : -l.side * l.wIn[k];
    out[(k - k0) * 2] = l.X[k] + l.NX[k] * o; out[(k - k0) * 2 + 1] = l.Z[k] + l.NZ[k] * o;
  }
  return out;
}

// The track's barrier on the lane's side, made to fit round the lane (the circuit is built with it, in every mode):
// - the entry opening (the lane's first sample's stretch to the pit wall's nose): the barrier bends out round the
//   lane's far edge, reaching it at the nose, where the far wall (walls.outer, which starts at that barrier point)
//   takes over;
// - from the nose to the tail: the pit wall's track face where that is nearer the track than the barrier was, else
//   the barrier as it was (the lane cutting far inside a corner); none across the lane's mouth, and a short wall
//   from the pit wall's tip to where the barrier starts again;
// - the exit opening: as the entry, mirrored.
// Returns the track samples (unwrapped indices) of the nose and the tail.
export function fitBarrier(tr: Track, l: PitLane): { iNose: number; iTail: number } {
  const side = l.side, bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
  const edge = side > 0 ? tr.WL : tr.WR, N = tr.N, ds = tr.L / N;
  const kn = l.kNose, kt = l.kTail;
  // unwrapped track samples along the lane's stretch: each lane sample's own (nearest) sample, unwrapped near its lap
  // position (the data's s may be a few metres off the nearest sample)
  const iAt = (k: number) => { const i = Math.round(l.S[k] / ds); return i + (wrapI(l.I[k] - i + N / 2, N) - N / 2); };
  const i0 = iAt(0), iN = iAt(kn), iT = iAt(kt), i1 = iAt(l.n - 1);
  const far = edgeLine(l, 'out'), face = l.walls.track, orig = Float64Array.from(bar), origValid = Uint8Array.from(valid);
  const ray = (i: number, pl: Polyline, maxT: number, hit?: { seg: number; f: number }) => {
    const j = wrapI(i, N);
    return rayPolyline(tr.X[j], tr.Z[j], side * tr.NX[j], side * tr.NZ[j], pl, maxT, hit);
  };
  const opening = (from: number, to: number, at: number) => {   // samples from..to, the nose (or tail) at `at`
    const rampN = Math.max(1, Math.min(30, Math.abs(at - from)));
    for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1) {
      const j = wrapI(i, N), lo = ray(i, far, orig[j] + 80);
      if (!(lo > 0)) continue;
      const ramp = smoothstep(1 - Math.abs(at - i) / rampN);
      bar[j] = Math.max(lo, lerp(orig[j], Math.max(lo, edge[j] + 3), ramp));
      valid[j] = 1;
    }
  };
  opening(i0, iN, iN);
  opening(i1, iT, iT);
  // From the nose to the tail: the pit wall's track face where it is nearer the track than the barrier was, else the
  // barrier as it was; none where that would be on the lane (its mouth, after the nose and before the tail: the jump
  // from the far wall to the pit wall). A short wall (walls.joins) closes each gap from the pit wall's tip to the
  // barrier's first (last) point: beside the track that is a few cm of the pit wall's face, at a steep entry (Monaco)
  // the barrier's start, set back from the tapered nose, as an attenuator would be.
  const p: LanePos = { d: 0, off: 0, k: 0 };
  const middle = (i: number) => {
    const j = wrapI(i, N), d = ray(i, face, orig[j] + 1);
    return d > 0 && d < orig[j] ? { off: d, valid: 1 } : { off: orig[j], valid: origValid[j] };
  };
  const onLane = (i: number, off: number) => { const j = wrapI(i, N); return laneAt(l, tr.X[j] + side * tr.NX[j] * off, tr.Z[j] + side * tr.NZ[j] * off, p); };
  let a = iN + 2, b = iT - 2;
  while (a < b && onLane(a, middle(a).off)) a++;
  while (b > a && onLane(b, middle(b).off)) b--;
  for (let i = iN + 1; i <= iT - 1; i++) {
    const j = wrapI(i, N);
    if (i < a || i > b) { valid[j] = 0; continue; }
    const m = middle(i);
    bar[j] = m.off; valid[j] = m.valid;
  }
  const barPoint = (i: number) => { const j = wrapI(i, N); return [tr.X[j] + side * tr.NX[j] * bar[j], tr.Z[j] + side * tr.NZ[j] * bar[j]]; };
  const lf = l.walls.lane;
  (l.walls as { joins: Polyline[] }).joins = [
    Float64Array.from([lf[0], lf[1], ...barPoint(a)]), Float64Array.from([...barPoint(b), lf[lf.length - 2], lf[lf.length - 1]]),
  ];
  // the far wall starts and ends at the barrier's points at the nose and the tail
  const pN = wrapI(iN, N), pT = wrapI(iT, N);
  const startX = tr.X[pN] + side * tr.NX[pN] * bar[pN], startZ = tr.Z[pN] + side * tr.NZ[pN] * bar[pN];
  const endX = tr.X[pT] + side * tr.NX[pT] * bar[pT], endZ = tr.Z[pT] + side * tr.NZ[pT] * bar[pT];
  const hN = { seg: 0, f: 0 }, hT = { seg: 0, f: 0 };
  ray(iN, far, orig[pN] + 80, hN); ray(iT, far, orig[pT] + 80, hT);
  const pts: number[] = [startX, startZ];
  for (let k = hN.seg + 1; k <= hT.seg; k++) pts.push(far[2 * k], far[2 * k + 1]);
  pts.push(endX, endZ);
  (l.walls as { outer: Polyline }).outer = Float64Array.from(pts);
  (l as { building: PitLane['building'] }).building = buildingOf(tr, l);   // (clear of the barriers as they now are)
  return { iNose: iN, iTail: iT };
}
