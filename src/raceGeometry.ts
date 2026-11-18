import { LANE, lanePoint, laneLapS, type PitLane } from './pitLane';
import { pointAt, type Track } from './track';
import { wrapI } from './util';

// ============================================================================
// Race weekend geometry, from the track alone (so every client works out the same): the starting grid, and the pit
// lane's rules (the lane is the circuit's: pitLane.ts). Pure maths, no rendering (pitLaneMesh.ts draws the lane).
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

// ---------------------------------------------------------------------------- the pit lane's rules
// The lane itself is the circuit's (pitLane.ts, in every mode); in a room weekend.ts applies these rules to it: the
// limit (LANE.limitKmh) from the first limit line to the second, where the limiter cuts the throttle above it and does
// nothing else (the game never brakes for the driver); over it by more than speedTolKmh is speeding. The box is boxLen
// long: a car at rest with its centre in it (and in the working lane) is serviced. The guidance's BRAKE cue is timed
// for braking at cueShare of the car's low-speed braking (CarInfo.autoLong) after cueSecs of reaction: firm, with
// some in hand.
export const PIT = {
  limitKmh: LANE.limitKmh, speedTolKmh: 5, boxLen: 10, boxWidth: LANE.work, cueShare: 0.7, cueSecs: 0.3,
} as const;

// Whether a car at v m/s, `dist` m before the point where it must be down to `target` m/s, should be braking now
// (the guidance's cue): braking at `decel` m/s² from PIT.cueSecs later would just make it.
export function brakeCue(v: number, dist: number, target: number, decel: number): boolean {
  if (v <= target + 0.5) return false;
  return dist <= (v * v - target * target) / (2 * decel) + v * PIT.cueSecs;
}

// Where to put a car d m along the lane, `off` m from its path (+ towards the far side), facing down the lane, as
// Session.placeCar and Vehicle.placeAt take it: the lap position s whose normal passes through the point (found from
// the lane's own lap position there), the offset lat along it (pointAt(tr, s, lat) is the point), and the heading off
// the track's direction there.
export function lanePlacement(tr: Track, l: PitLane, d: number, off: number): { s: number; lat: number; heading: number } {
  const p = lanePoint(l, d, off);
  // pointAt(tr, s, lat) is C(s) + n(s) lat with n interpolated between samples: find s where p - C(s) lies along n(s)
  // (secant steps from the lane's own lap position), then lat along it
  const g = (s: number) => { const c = pointAt(tr, s), q = pointAt(tr, s, 1); return (p.x - c.x) * (q.z - c.z) - (p.z - c.z) * (q.x - c.x); };
  let s0 = laneLapS(l, tr.L, d), g0 = g(s0), s1 = s0 + 0.5, g1 = g(s1);
  for (let it = 0; it < 30 && Math.abs(g1) > 1e-7 && g1 !== g0; it++) {
    const s2 = s1 - (g1 * (s1 - s0)) / (g1 - g0);
    s0 = s1; g0 = g1; s1 = s2; g1 = g(s1);
  }
  const s = ((s1 % tr.L) + tr.L) % tr.L, c = pointAt(tr, s), q = pointAt(tr, s, 1), nx = q.x - c.x, nz = q.z - c.z, i = c.i;
  const lat = ((p.x - c.x) * nx + (p.z - c.z) * nz) / (nx * nx + nz * nz);
  let heading = Math.atan2(p.tx, p.tz) - Math.atan2(tr.TX[i], tr.TZ[i]);
  heading = Math.atan2(Math.sin(heading), Math.cos(heading));
  return { s, lat, heading };
}
