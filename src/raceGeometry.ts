import { pitBuilding } from './scenery';
import type { Track, TrackPos } from './track';
import type { TrackDef } from './tracks';
import { wrapI } from './util';

// ============================================================================
// Race weekend geometry, from the track alone (so every client works out the same): the starting grid and the pit
// lane. Pure maths, no rendering (pitLaneMesh.ts draws the lane).
// ============================================================================

// ---------------------------------------------------------------------------- the grid
// Two columns, staggered: slot k is GRID_FRONT + k x GRID_GAP m behind the line, pole on the inside of the first
// corner, the columns GRID_COL m either side of the middle of the road (less where the road is narrow, so a car's
// side stays GRID_EDGE m inside the edge). 8 m between consecutive slots is 16 m nose to nose in a column: the F1,
// the longest car (5.6 m), has 10 m in front of it. The 32 slots a full room needs reach 256 m back, which every
// circuit's start straight (or the bend before it) has room for (test/raceGeometry.test.ts).
export const GRID = { front: 8, gap: 8, col: 3, edge: 1.6, halfWidth: 1.1 } as const;
export interface GridSlot { s: number; lat: number }

export function gridSlots(tr: Track, n: number): GridSlot[] {
  const pole = poleSide(tr), out: GridSlot[] = [];
  for (let k = 0; k < n; k++) {
    const s = tr.L - (GRID.front + k * GRID.gap), i = wrapI(Math.round((s / tr.L) * tr.N), tr.N);
    const mid = (tr.WL[i] - tr.WR[i]) / 2, room = (tr.WL[i] + tr.WR[i]) / 2 - GRID.edge - GRID.halfWidth;
    const side = k % 2 === 0 ? pole : -pole;
    out.push({ s, lat: mid + side * Math.max(0, Math.min(GRID.col, room)) });
  }
  return out;
}

// +1 (left) or -1: the side of the road on the inside of the first real corner after the line.
export function poleSide(tr: Track): 1 | -1 {
  for (let k = 0; k < tr.N; k++) if (Math.abs(tr.KS[k]) > 1 / 200) return tr.KS[k] > 0 ? 1 : -1;
  return 1;
}

// ---------------------------------------------------------------------------- the pit lane
// A marked strip along the pit building's side of the start straight, PIT.width wide, as far from the track as the
// run-off allows: its inner edge PIT.trackGap beyond the track's edge, or nearer (into the track, on a street
// circuit's 3.5 m of pavement) so that its outer edge stays PIT.wallGap off the barrier. One rule for every circuit.
// Along the lap it is centred on the pit building: a speed-limited stretch as long as the building (at most
// PIT.maxLimit m), with an entry and an exit ramp of PIT.ramp m either end, and the box in the middle. The ground
// is asphalt from the track's edge to the lane's outer edge all along, and none of it is outside the track limits
// (enablePitLane): driving in is a drift across painted lines, not a lap deleted.
export const PIT = {
  width: 4, trackGap: 2, wallGap: 0.6, ramp: 60, maxLimit: 320, limitKmh: 80, boxLen: 12, brakeMs2: 9,
} as const;

export interface PitLane {
  readonly side: 1 | -1;              // the side of the track it is on (+1 left)
  readonly k0: number;                // its first sample, counted from the line (negative: before it); wrapI for the index
  readonly n: number;                 // samples it spans
  readonly sStart: number;            // track s of its start (0..L)
  readonly len: number;               // m from its start to its end, along the track
  readonly limIn: number; readonly limOut: number;   // the speed limit's start and end (m from the lane's start)
  readonly box: number;               // the box's centre (m from the lane's start)
  readonly inner: Float64Array; readonly outer: Float64Array;   // per lane sample: its edges as side x lat (m)
  readonly edge: Float64Array;        // ...and the track's edge on that side
  readonly limitMs: number;           // the speed limit (m/s)
}

export function buildPitLane(tr: Track, def: Pick<TrackDef, 'pit' | 'pitSide'>): PitLane {
  const ds = tr.L / tr.N, side = def.pitSide;
  const b = pitBuilding(tr, def);
  const b0 = b ? b.k0 : Math.round(def.pit[0] / ds), b1 = b ? b.k1 : Math.round(def.pit[1] / ds);
  const mid = (b0 + b1) / 2, half = Math.min((b1 - b0) * ds, PIT.maxLimit) / 2 / ds, ramp = Math.round(PIT.ramp / ds);
  const lim0 = Math.round(mid - half), lim1 = Math.round(mid + half), k0 = lim0 - ramp, n = lim1 + ramp - k0 + 1;
  const edgeA = side > 0 ? tr.WL : tr.WR, barA = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
  // the inner edge's offset from the track edge each sample allows; then a minimum over 2w either side and a mean over
  // w, which keeps every sample within what it allows and takes the kinks out
  const w = 10, pad = 2 * w + w, m = n + 2 * pad, allow = new Float64Array(m), lo = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const i = wrapI(k0 - pad + j, tr.N);
    const room = valid[i] ? barA[i] - PIT.wallGap - PIT.width - edgeA[i] : Infinity;
    allow[j] = Math.min(PIT.trackGap, room);
  }
  for (let j = 2 * w; j < m - 2 * w; j++) { let v = Infinity; for (let d = -2 * w; d <= 2 * w; d++) v = Math.min(v, allow[j + d]); lo[j] = v; }
  const inner = new Float64Array(n), outer = new Float64Array(n), edge = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const j = k + pad, i = wrapI(k0 + k, tr.N);
    let g = 0; for (let d = -w; d <= w; d++) g += lo[j + d];
    edge[k] = edgeA[i]; inner[k] = edgeA[i] + g / (2 * w + 1); outer[k] = inner[k] + PIT.width;
  }
  const sAt = (k: number) => k * ds;
  return {
    side, k0, n, sStart: tr.S[wrapI(k0, tr.N)], len: sAt(n - 1), limIn: sAt(ramp), limOut: sAt(lim1 - k0), box: sAt(Math.round(mid) - k0),
    inner, outer, edge, limitMs: PIT.limitKmh / 3.6,
  };
}

// The lane sample (0..n-1) at track sample i, or -1 if the lane does not run there.
export function laneIndex(lane: PitLane, tr: Track, i: number): number {
  const k = wrapI(i - lane.k0, tr.N);
  return k < lane.n ? k : -1;
}
// m along the lane from its start at track position p (may be beyond len: not alongside the lane).
export function laneDist(lane: PitLane, tr: Track, s: number): number {
  return ((s - lane.sStart) % tr.L + tr.L) % tr.L;
}

// Where a car (its centre at p) is with respect to the lane: 'lane' when its centre is in the lane's outer half
// width (beyond the lane's middle less 1.2 m, so a car racing on a street circuit's edge, which the lane overlaps,
// is not in it), 'near' between the track edge and that, else 'track'. Hysteresis is the caller's.
export function laneZone(lane: PitLane, tr: Track, p: TrackPos): 'lane' | 'near' | 'track' {
  const k = laneIndex(lane, tr, p.i);
  if (k < 0) return 'track';
  const x = lane.side * p.lat;
  if (x > lane.outer[k] + 1.5) return 'track';
  if (x >= (lane.inner[k] + lane.outer[k]) / 2 - 1.2) return 'lane';
  return x >= lane.inner[k] - 0.6 ? 'near' : 'track';
}

// The fastest a car in the lane may go at d m from its start: the limit through the limited stretch, and on the entry
// ramp what braking at PIT.brakeMs2 down to it at the limit line allows; free on the exit ramp.
export function laneLimit(lane: PitLane, d: number): number {
  if (d < 0 || d > lane.limOut) return Infinity;
  if (d >= lane.limIn) return lane.limitMs;
  return Math.sqrt(lane.limitMs ** 2 + 2 * PIT.brakeMs2 * (lane.limIn - d));
}

// The track's own mask for the lane (Track.pitLane): what surfaceAt and trackLimitOut read. Set only in a room, so a
// time trial's track is exactly as before. null takes it away.
export function enablePitLane(tr: Track, lane: PitLane | null) {
  if (!lane) { tr.pitLane = undefined; return; }
  const outer = new Float64Array(tr.N).fill(Number.NaN);
  for (let k = 0; k < lane.n; k++) outer[wrapI(lane.k0 + k, tr.N)] = lane.outer[k];
  tr.pitLane = { side: lane.side, outer };
}
