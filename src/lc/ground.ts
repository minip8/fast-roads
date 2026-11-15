import { S_ASPHALT, S_GRASS, S_GRAVEL, S_KERB } from '../config';
import { surfaceAt, type SurfaceRes, type Track, type TrackPos } from '../track';
import type { GroundHit, GroundQuery, WallQuery } from './vendor/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE, type TrackSurfaceKind } from './vendor/sim/track-surfaces';

// ============================================================================
// Our track as LibreCorsa's engine sees it: the ground under a point (flat at y = 0, kerbs raised as surfaceAt says,
// our four surfaces as their surface kinds) and the barriers as wall segments. The engine asks the ground for every
// wheel on every 2 kHz substep, so both answer from a grid built once per track.
//
// Both are stateless (an answer depends on the point alone, never on earlier queries), which lets the engine reuse a
// settle it has done before (its settle memo). The nearest centreline sample is found among each grid cell's
// candidates, which gives exactly what projectOnTrack's global search does for any point within FAR of the
// centreline; farther out everything is grass.
// ============================================================================
const CELL = 8;          // m
const FAR = 60;          // m from the nearest centreline sample: beyond every barrier and gravel trap
const KIND: TrackSurfaceKind[] = [];
KIND[S_ASPHALT] = 'road'; KIND[S_KERB] = 'kerb'; KIND[S_GRASS] = 'grass'; KIND[S_GRAVEL] = 'gravel';
export const surfaceKind = (surf: number) => KIND[surf];

// Uniform XZ grid in CSR form: cell c holds items[start[c] .. start[c + 1]).
interface Grid { minX: number; minZ: number; nx: number; nz: number; start: Uint32Array; items: Uint32Array }
const cellOf = (v: number, min: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((v - min) / CELL)));

// Each of `count` items goes into every cell its box [x0, z0, x1, z1] overlaps.
function buildGrid(minX: number, minZ: number, maxX: number, maxZ: number, count: number, box: (i: number, b: Float64Array) => void): Grid {
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL)), nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL)), cells = nx * nz;
  const b = new Float64Array(4), start = new Uint32Array(cells + 1);
  const each = (i: number, fn: (c: number) => void) => {
    box(i, b);
    for (let cz = cellOf(b[1], minZ, nz), cz1 = cellOf(b[3], minZ, nz); cz <= cz1; cz++)
      for (let cx = cellOf(b[0], minX, nx), cx1 = cellOf(b[2], minX, nx); cx <= cx1; cx++) fn(cz * nx + cx);
  };
  for (let i = 0; i < count; i++) each(i, (c) => start[c + 1]++);
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const items = new Uint32Array(start[cells]), fill = start.slice(0, cells);
  for (let i = 0; i < count; i++) each(i, (c) => (items[fill[c]++] = i));
  return { minX, minZ, nx, nz, start, items };
}

// Centreline samples per cell: every sample that can be the nearest one to a point in the cell. A sample within FAR
// of the point is in its cell's list; then a sample farther from the whole cell than some other sample is from the
// cell's farthest corner can never be nearest, and is dropped. Lists stay in index order, so ties go as in
// projectOnTrack (the lowest index).
function sampleGrid(tr: Track): Grid {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < tr.N; i++) {
    minX = Math.min(minX, tr.X[i]); maxX = Math.max(maxX, tr.X[i]); minZ = Math.min(minZ, tr.Z[i]); maxZ = Math.max(maxZ, tr.Z[i]);
  }
  minX -= FAR; minZ -= FAR; maxX += FAR; maxZ += FAR;
  const g = buildGrid(minX, minZ, maxX, maxZ, tr.N, (i, b) => { b[0] = tr.X[i] - FAR; b[1] = tr.Z[i] - FAR; b[2] = tr.X[i] + FAR; b[3] = tr.Z[i] + FAR; });
  const start = new Uint32Array(g.start.length), kept: number[] = [];
  for (let c = 0; c < g.nx * g.nz; c++) {
    const x0 = g.minX + (c % g.nx) * CELL, z0 = g.minZ + Math.floor(c / g.nx) * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
    let worst = Infinity;
    for (let k = g.start[c]; k < g.start[c + 1]; k++) {
      const i = g.items[k], fx = Math.max(Math.abs(tr.X[i] - x0), Math.abs(tr.X[i] - x1)), fz = Math.max(Math.abs(tr.Z[i] - z0), Math.abs(tr.Z[i] - z1));
      worst = Math.min(worst, fx * fx + fz * fz);
    }
    for (let k = g.start[c]; k < g.start[c + 1]; k++) {
      const i = g.items[k], dx = Math.max(x0 - tr.X[i], 0, tr.X[i] - x1), dz = Math.max(z0 - tr.Z[i], 0, tr.Z[i] - z1);
      if (dx * dx + dz * dz <= worst) kept.push(i);
    }
    start[c + 1] = kept.length;
  }
  return { ...g, start, items: Uint32Array.from(kept) };
}

const grids = new WeakMap<Track, Grid>();

// projectOnTrack's answer (global search) without a hint, or false for a point farther than FAR from the centreline.
export function projectNear(tr: Track, x: number, z: number, out: TrackPos): boolean {
  let g = grids.get(tr);
  if (!g) grids.set(tr, (g = sampleGrid(tr)));
  const c = cellOf(z, g.minZ, g.nz) * g.nx + cellOf(x, g.minX, g.nx);
  let best = -1, bd = FAR * FAR;
  for (let k = g.start[c], end = g.start[c + 1]; k < end; k++) {
    const i = g.items[k], dx = x - tr.X[i], dz = z - tr.Z[i], d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) return false;
  const dx = x - tr.X[best], dz = z - tr.Z[best], s = tr.S[best] + dx * tr.TX[best] + dz * tr.TZ[best];
  out.i = best;
  out.lat = dx * tr.NX[best] + dz * tr.NZ[best];
  out.s = ((s % tr.L) + tr.L) % tr.L;
  return true;
}

// The ground: flat at y = 0 with our kerbs' height on top, one probe per wheel (smooth). `force` (a SURF index)
// pretends every point is that surface (the height stays the real one), as Car.forceSurface does.
export class TrackGround implements GroundQuery {
  readonly smooth = true;
  readonly stateless = true;
  private readonly pos: TrackPos = { i: 0, s: 0, lat: 0 };
  private readonly res: SurfaceRes = { surf: 0, h: 0 };
  constructor(private readonly track: Track, private readonly force?: number) {}

  query(x: number, z: number, probeY: number, out: GroundHit): boolean {
    let surf = S_GRASS, h = 0;
    if (projectNear(this.track, x, z, this.pos)) {
      surf = surfaceAt(this.track, this.pos.i, this.pos.lat, this.pos.s, this.res);
      h = this.res.h;
    }
    if (h > probeY) return false;
    const props = DEFAULT_SURFACE_TABLE[KIND[this.force ?? surf]];
    out.height = h;
    out.nx = 0; out.ny = 1; out.nz = 0;
    out.surface = KIND[this.force ?? surf];
    out.grip = props.friction;
    out.props = props;
    out.source = '';
    return true;
  }
}

// One ground per track and forced surface, so a car always gets the same object for the same answers (the settle
// memo tells grounds apart by identity).
const grounds = new WeakMap<Track, Map<number, TrackGround>>();
export function trackGround(tr: Track, force?: number): TrackGround {
  let m = grounds.get(tr);
  if (!m) grounds.set(tr, (m = new Map()));
  const key = force ?? -1;
  let g = m.get(key);
  if (!g) m.set(key, (g = new TrackGround(tr, force)));
  return g;
}

// The barriers: the road-facing side of each wall cuboid buildTrackColliders makes, as a vertical segment over the
// cuboid's height (0..1.6 m) and half a metre below it, in case a kerb lifts the car.
export class TrackWalls implements WallQuery {
  readonly stateless = true;
  readonly segments: Float32Array;
  private readonly grid: Grid;
  private readonly stamp: Uint32Array;
  private query = 0;

  constructor(tr: Track) {
    const segs: number[] = [];
    for (const side of [1, -1]) {
      const off = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
      for (let i = 0; i < tr.N; i++) {
        const j = (i + 1) % tr.N;
        if (!valid[i] || !valid[j]) continue;
        const ax = tr.X[i] + tr.NX[i] * side * off[i], az = tr.Z[i] + tr.NZ[i] * side * off[i];
        const bx = tr.X[j] + tr.NX[j] * side * off[j], bz = tr.Z[j] + tr.NZ[j] * side * off[j];
        if (Math.hypot(bx - ax, bz - az) < 0.01) continue;
        segs.push(ax, az, bx, bz, -0.5, 1.6);
      }
    }
    this.segments = Float32Array.from(segs);
    const n = segs.length / 6, s = this.segments;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < n * 6; k += 6) {
      minX = Math.min(minX, s[k], s[k + 2]); maxX = Math.max(maxX, s[k], s[k + 2]);
      minZ = Math.min(minZ, s[k + 1], s[k + 3]); maxZ = Math.max(maxZ, s[k + 1], s[k + 3]);
    }
    if (n === 0) minX = minZ = maxX = maxZ = 0;
    this.grid = buildGrid(minX, minZ, maxX, maxZ, n, (i, b) => {
      const k = i * 6;
      b[0] = Math.min(s[k], s[k + 2]); b[1] = Math.min(s[k + 1], s[k + 3]); b[2] = Math.max(s[k], s[k + 2]); b[3] = Math.max(s[k + 1], s[k + 3]);
    });
    this.stamp = new Uint32Array(n);
  }

  // The stamp only stops a segment listed in two cells from being returned twice: answers depend on the arguments alone.
  near(x: number, z: number, radius: number, out: Int32Array): number {
    const g = this.grid, s = this.segments, r2 = radius * radius, id = ++this.query;
    if (id === 0xffffffff) { this.stamp.fill(0); this.query = 0; }
    let count = 0;
    for (let cz = cellOf(z - radius, g.minZ, g.nz), cz1 = cellOf(z + radius, g.minZ, g.nz); cz <= cz1; cz++) {
      for (let cx = cellOf(x - radius, g.minX, g.nx), cx1 = cellOf(x + radius, g.minX, g.nx); cx <= cx1; cx++) {
        const c = cz * g.nx + cx;
        for (let k = g.start[c], end = g.start[c + 1]; k < end; k++) {
          const i = g.items[k];
          if (this.stamp[i] === id) continue;
          this.stamp[i] = id;
          const o = i * 6, ax = s[o], az = s[o + 1], dx = s[o + 2] - ax, dz = s[o + 3] - az, len2 = dx * dx + dz * dz;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
          const ex = ax + t * dx - x, ez = az + t * dz - z;
          if (ex * ex + ez * ez > r2) continue;
          if (count >= out.length) return count;
          out[count++] = i;
        }
      }
    }
    return count;
  }
}

const walls = new WeakMap<Track, TrackWalls>();
export function trackWalls(tr: Track): TrackWalls {
  let w = walls.get(tr);
  if (!w) walls.set(tr, (w = new TrackWalls(tr)));
  return w;
}
