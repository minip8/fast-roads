// The race weekend's geometry at every circuit: the starting grid for a full room (src/raceGeometry.ts), and the pit
// lane as the circuit is built with it in every mode (src/pitLane.ts, circuit.ts): the real lane from tracks/pits/,
// its walls and the track's barrier round it, the openings, the box, the waiting spots and the pit building, against
// the track, the rest of the lap, the grid and the start spot; and how the physics, the timing and the placements see
// it. PITLANE_SVG=<folder> also draws each circuit there (test/pitLaneDraw.ts); PITLANE_REPORT=1 prints a line each.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildCircuit } from '../src/circuit';
import { S_ASPHALT } from '../src/config';
import { trackWalls } from '../src/lc/ground';
import { clearOfTrack, LANE, lanePoint, laneAt, laneLapS, laneValue, pitFootprint, type LanePos, type PitLane } from '../src/pitLane';
import { gridSlots, GRID, lanePlacement, PIT } from '../src/raceGeometry';
import { GANTRY_POST, gantryPosts } from '../src/scenery';
import { Timing } from '../src/timing';
import { buildTrack, inPitLane, locate, parseCSV, pointAt, projectOnTrack, surfaceAt, wheelGround, type Track, type TrackPos } from '../src/track';
import { loadPitCsv, loadTrackCsv, TRACKS, type TrackId } from '../src/tracks';
import { wrapI } from '../src/util';
import { waitingSpot } from '../src/weekend';
import { trackFor } from './harness';
import { drawPitLane } from './pitLaneDraw';

const IDS = Object.keys(TRACKS) as TrackId[];
const SVG = process.env.PITLANE_SVG;
const CAR_HALF_LEN = 2.8;      // the F1, the longest car (5.6 m)

describe('the starting grid', () => {
  test.each(IDS)('%s: 32 slots behind the line, on the road, apart', async (id) => {
    const tr = await trackFor(id), slots = gridSlots(tr, 32), res = { surf: 0, h: 0 };
    const world = slots.map((g) => pointAt(tr, g.s, g.lat));
    for (const [k, g] of slots.entries()) {
      expect(g.s).toBeLessThan(tr.L - GRID.front + 1e-6);
      expect(tr.L - g.s).toBeLessThan(270);
      // the car's four corners on asphalt, inside the edges
      const p = pointAt(tr, g.s), i = p.i, tx = tr.TX[i], tz = tr.TZ[i], nx = tr.NX[i], nz = tr.NZ[i];
      for (const a of [-CAR_HALF_LEN, CAR_HALF_LEN]) for (const b of [-GRID.halfWidth, GRID.halfWidth]) {
        const x = world[k].x + tx * a + nx * b, z = world[k].z + tz * a + nz * b;
        const q = projectOnTrack(tr, x, z, i, { i: 0, s: 0, lat: 0 });
        expect(surfaceAt(tr, q.i, q.lat, q.s, res), `${id} slot ${k}`).toBe(S_ASPHALT);
        expect(q.lat).toBeLessThan(tr.WL[q.i] - 0.3); expect(q.lat).toBeGreaterThan(-tr.WR[q.i] + 0.3);
      }
      // staggered: the two columns either side of the middle
      if (k > 0) expect(Math.sign(g.lat - (tr.WL[i] - tr.WR[i]) / 2)).toBe(-Math.sign(slots[k - 1].lat - (tr.WL[pointAt(tr, slots[k - 1].s).i] - tr.WR[pointAt(tr, slots[k - 1].s).i]) / 2));
    }
    // every pair at least a car length and a half apart
    for (let a = 0; a < world.length; a++) for (let b = a + 1; b < world.length; b++) {
      expect(Math.hypot(world[a].x - world[b].x, world[a].z - world[b].z), `${id} slots ${a}, ${b}`).toBeGreaterThan(6);
    }
  });
});

const segX = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) => {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return false;
  const qx = cx - ax, qz = cz - az, t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
};
const crosses = (ax: number, az: number, bx: number, bz: number, pl: Float64Array) => {
  for (let j = 0; j + 3 < pl.length; j += 2) if (segX(ax, az, bx, bz, pl[j], pl[j + 1], pl[j + 2], pl[j + 3])) return true;
  return false;
};
async function circuit(id: TrackId): Promise<{ tr: Track; plain: Track; l: PitLane }> {
  const def = TRACKS[id], csv = await loadTrackCsv(id), tr = buildCircuit(csv, await loadPitCsv(id), def);
  return { tr, plain: buildTrack(parseCSV(csv), { street: def.street }), l: tr.pit! };
}

describe('the pit lane', () => {
  test.each(IDS)('%s', async (id) => {
    const def = TRACKS[id], { tr, plain, l } = await circuit(id), N = tr.N, ds = tr.L / N, side = l.side;
    if (SVG) {
      fs.mkdirSync(SVG, { recursive: true });
      fs.writeFileSync(path.join(SVG, `${id}.svg`), drawPitLane(tr, def));
      for (const [name, k] of [['entry', l.kNose], ['exit', l.kTail]] as const) fs.writeFileSync(path.join(SVG, `${id}-${name}.svg`), drawPitLane(tr, def, [], { x: l.X[k], z: l.Z[k], r: 70 }));
    }
    expect(l.side).toBe(def.pitSide);
    const edgeA = side > 0 ? tr.WL : tr.WR, bar = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    const lat = (i: number, x: number, z: number) => (x - tr.X[i]) * tr.NX[i] + (z - tr.Z[i]) * tr.NZ[i];
    const kn = l.kNose, kt = l.kTail;
    // it starts and ends on the track's road
    for (const k of [0, l.n - 1]) expect(Math.abs(lat(l.I[k], l.X[k], l.Z[k])), `${id} end ${k}`).toBeLessThan(edgeA[l.I[k]]);
    // its order: entry, nose, limit line, working stretch with the box, limit line, tail, exit
    expect(0 < l.nose && l.nose < l.limIn && l.limIn < l.work[0] && l.work[0] < l.box && l.box < l.work[1] && l.work[1] < l.limOut && l.limOut < l.tail && l.tail < l.len).toBe(true);
    expect(l.limOut - l.limIn).toBeGreaterThan(150);
    // the minimum width throughout, the fast lane's exactly between the walls
    for (let k = 0; k < l.n; k++) {
      expect(l.wIn[k] + l.wOut[k]).toBeGreaterThanOrEqual(LANE.fast - 1e-9);
      if (k >= kn && k <= kt) expect(l.wIn[k]).toBeCloseTo(LANE.fast / 2, 9);
    }
    // between the openings: off its own stretch's road (the pit wall LANE.gap off its edge at least), and clear of
    // the rest of the lap and its walls
    const span = (j: number) => wrapI(j - (l.I[0] - 20), N) <= wrapI(l.I[l.n - 1] - l.I[0], N) + 40;
    const bad: string[] = [];
    for (let k = kn; k <= kt; k += 2) {
      for (const off of [-l.wIn[k] - LANE.wall, 0, l.wOut[k] + LANE.outerWall]) {
        const x = l.X[k] + side * l.NX[k] * off, z = l.Z[k] + side * l.NZ[k] * off;
        for (let j = 0; j < N; j++) {
          const dx = x - tr.X[j], dz = z - tr.Z[j];
          if (dx * dx + dz * dz > 3600 || Math.abs(dx * tr.TX[j] + dz * tr.TZ[j]) > 1.2) continue;
          const a = Math.abs(lat(j, x, z)), e = lat(j, x, z) > 0 ? tr.WL[j] : tr.WR[j];
          if (span(j) ? a < e + LANE.gap - 0.05 : a < (lat(j, x, z) > 0 ? (plain.barLValid[j] ? plain.barL[j] : e + 3.5) : (plain.barRValid[j] ? plain.barR[j] : e + 3.5)) + 0.3) {
            bad.push(`${l.D[k].toFixed(0)} m along (off ${off.toFixed(1)}): sample ${j}${span(j) ? ' (its stretch)' : ''}`); break;
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // the pit wall is whole from the nose to the tail, and stands between the track and the lane all along
    const { lane: lf, outer } = l.walls;
    for (let j = 0; j + 3 < lf.length; j += 2) expect(Math.hypot(lf[j + 2] - lf[j], lf[j + 3] - lf[j + 1])).toBeLessThan(2.6);
    for (let j = 0; j + 3 < outer.length; j += 2) expect(Math.hypot(outer[j + 2] - outer[j], outer[j + 3] - outer[j + 1]), `${id} far wall at ${j / 2}`).toBeLessThan(4);
    for (let k = kn + 15; k <= kt - 15; k++) {
      const i = l.I[k], cx = tr.X[i] + side * tr.NX[i] * Math.min(edgeA[i] - 1, Math.max(0, lat(i, l.X[k], l.Z[k]) * side - 20)), cz = tr.Z[i] + side * tr.NZ[i] * Math.min(edgeA[i] - 1, Math.max(0, lat(i, l.X[k], l.Z[k]) * side - 20));
      if (!crosses(cx, cz, l.X[k], l.Z[k], lf)) { bad.push(`no pit wall between the track and ${l.D[k].toFixed(0)} m along`); break; }
    }
    expect(bad).toEqual([]);
    // the track's barrier on that side: open at the entry and the exit (one sample each, where it jumps from the far
    // wall to the pit wall) and nowhere else it was not open before; joined to the far wall and the pit wall there
    const iAt = (k: number) => { const i = Math.round(l.S[k] / ds); return i + (wrapI(l.I[k] - i + N / 2, N) - N / 2); };
    const i0 = iAt(0), iN = iAt(kn), iT = iAt(kt), i1 = iAt(l.n - 1);
    const plainValid = side > 0 ? plain.barLValid : plain.barRValid;
    const opened: number[] = [];
    for (let i = i0 - 30; i <= i1 + 30; i++) if (!valid[wrapI(i, N)] && plainValid[wrapI(i, N)]) opened.push(i);
    // (the first and last samples whose ray meets the pit wall's track face: at most a few past the nose and tail)
    const a = opened.filter((i) => i <= (iN + iT) / 2), b = opened.filter((i) => i > (iN + iT) / 2);
    expect(a[0]).toBe(iN + 1); expect(a.length).toBeLessThanOrEqual(5); expect(a.at(-1)! - a[0]).toBe(a.length - 1);
    expect(b.at(-1)).toBe(iT - 1); expect(b.length).toBeLessThanOrEqual(5); expect(b.at(-1)! - b[0]).toBe(b.length - 1);
    const barPt = (i: number) => { const j = wrapI(i, N); return [tr.X[j] + side * tr.NX[j] * bar[j], tr.Z[j] + side * tr.NZ[j] * bar[j]]; };
    expect(Math.hypot(barPt(iN)[0] - outer[0], barPt(iN)[1] - outer[1])).toBeLessThan(1e-6);
    expect(Math.hypot(barPt(iT)[0] - outer[outer.length - 2], barPt(iT)[1] - outer[outer.length - 1])).toBeLessThan(1e-6);
    // ...and a short wall from the pit wall's tip to each of the barrier's ends there
    const [j0, j1] = l.walls.joins;
    expect(Math.hypot(j0[0] - lf[0], j0[1] - lf[1])).toBe(0);
    expect(Math.hypot(j0[2] - barPt(a.at(-1)! + 1)[0], j0[3] - barPt(a.at(-1)! + 1)[1])).toBeLessThan(1e-9);
    expect(Math.hypot(j1[0] - barPt(b[0] - 1)[0], j1[1] - barPt(b[0] - 1)[1])).toBeLessThan(1e-9);
    for (const j of [j0, j1]) expect(Math.hypot(j[2] - j[0], j[3] - j[1]), `${id}: a join ${Math.hypot(j[2] - j[0], j[3] - j[1]).toFixed(1)} m long`).toBeLessThan(12);
    // no barrier point on the lane's road
    const lp: LanePos = { d: 0, off: 0, k: 0 };
    for (let i = i0 - 30; i <= i1 + 30; i++) if (valid[wrapI(i, N)]) expect(laneAt(l, barPt(i)[0], barPt(i)[1], lp) && lp.off > -l.wIn[lp.k] + 0.05 && lp.off < l.wOut[lp.k] - 0.05, `${id}: barrier sample ${i} on the lane`).toBe(false);
    // the openings: a fast lane's width between the pit wall's end and the far wall's; the entry and the exit as
    // sharp as the real ones, but drivable (no bend tighter than 12 m in the lane's path)
    expect(Math.hypot(lf[0] - outer[0], lf[1] - outer[1])).toBeGreaterThan(LANE.fast - 0.5);
    expect(Math.hypot(lf[lf.length - 2] - outer[outer.length - 2], lf[lf.length - 1] - outer[outer.length - 1])).toBeGreaterThan(LANE.fast - 0.5);
    let sharpest = 0, tightest = Infinity;
    for (const [p, q] of [[0, kn], [kt, l.n - 1]]) for (let k = p; k <= q; k++) {
      const i = l.I[k];
      sharpest = Math.max(sharpest, Math.acos(Math.min(1, l.TX[k] * tr.TX[i] + l.TZ[k] * tr.TZ[i])) * 180 / Math.PI);
    }
    for (let k = 3; k < l.n - 3; k++) {
      const turn = Math.acos(Math.min(1, l.TX[k - 3] * l.TX[k + 3] + l.TZ[k - 3] * l.TZ[k + 3]));
      if (turn > 1e-6) tightest = Math.min(tightest, (l.D[k + 3] - l.D[k - 3]) / turn);
    }
    expect(tightest).toBeGreaterThan(12);
    // the grid and the start spot clear of the pit wall and off the lane
    const slots = gridSlots(tr, 32).map((g) => ({ s: g.s, lat: g.lat }));
    for (const g of [...slots, { s: tr.L - def.startBack, lat: 0 }]) {
      const p = pointAt(tr, g.s, g.lat), i = p.i;
      for (const a of [-CAR_HALF_LEN, CAR_HALF_LEN]) for (const b of [-GRID.halfWidth, GRID.halfWidth]) {
        const x = p.x + tr.TX[i] * a + tr.NX[i] * b, z = p.z + tr.TZ[i] * a + tr.NZ[i] * b;
        expect(Math.abs(lat(i, x, z)), `${id}: a car at ${g.s.toFixed(0)} on the road`).toBeLessThan((lat(i, x, z) > 0 ? tr.WL : tr.WR)[i]);
      }
      if (valid[i]) expect(bar[i] - edgeA[i], `${id}: the wall beside ${g.s.toFixed(0)}`).toBeGreaterThan(1.2);
    }
    // the box on the lane, in the working stretch; the pit building clear of the lane and of every part of the lap
    const box = lanePoint(l, l.box, l.boxOff);
    expect(laneAt(l, box.x, box.z, lp)).toBe(true);
    expect(lp.off).toBeGreaterThan(LANE.fast / 2);
    if (l.building) {
      const b = l.building;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1]]) {
        const x = b.x + b.ax * u * b.halfLen + b.nx * v * b.depth / 2, z = b.z + b.az * u * b.halfLen + b.nz * v * b.depth / 2;
        expect(laneAt(l, x, z, lp)).toBe(false);
        expect(clearOfTrack(tr, x, z, 0.5)).toBe(true);
      }
      expect(pitFootprint(l, b.x, b.z)).toBe(true);
    }
    // the footprint: the lane's road, its walls, a margin
    expect(pitFootprint(l, l.X[(kn + kt) >> 1], l.Z[(kn + kt) >> 1])).toBe(true);
    expect(pitFootprint(l, pointAt(tr, tr.L / 2 + 900).x + 5000, 0)).toBe(false);
    if (process.env.PITLANE_REPORT) {
      const m = (d: number) => { const s = laneLapS(l, tr.L, d); return Math.round(s > tr.L / 2 ? s - tr.L : s); };
      console.log(`${id}: ${side > 0 ? 'left' : 'right'}, ${l.len.toFixed(0)} m, entry ${m(0)}, nose ${m(l.nose)}, limit ${m(l.limIn)} to ${m(l.limOut)}, box ${m(l.box)}, tail ${m(l.tail)}, exit ${m(l.len)}; moved out ${l.moved.toFixed(1)} m; building ${l.building ? (2 * l.building.halfLen).toFixed(0) + ' m' : 'none'}; sharpest opening ${sharpest.toFixed(0)} deg, tightest bend ${tightest.toFixed(0)} m`);
    }
  });
});

describe('the pit lane in the physics, the timing and the placements', () => {
  test.each(IDS)('%s', async (id) => {
    const tr = await trackFor(id), l = tr.pit!, res = { surf: 0, h: 0 }, p: TrackPos = { i: -1, s: 0, lat: 0 }, lp: LanePos = { d: 0, off: 0, k: 0 };
    // its road is asphalt and inside the track limits, for both engines' wheels, from the nose to the tail; in it a car
    // is in the pit lane, at the lane's own lap position
    for (let d = l.nose + 1; d < l.tail; d += 7) for (const off of [-LANE.fast / 2 + 0.3, 0, l.boxOff]) {
      const q = lanePoint(l, d, Math.min(off, laneValue(l, l.wOut, d) - 0.3));
      expect(wheelGround(tr, q.x, q.z, -1, p, res), `${id}: out of limits ${d.toFixed(0)} m along`).toBe(false);
      expect(res.surf).toBe(S_ASPHALT);
      expect(inPitLane(tr, q.x, q.z)).toBe(true);
      locate(tr, q.x, q.z, -1, p);
      expect(Math.abs(((p.s - laneLapS(l, tr.L, d)) % tr.L + tr.L * 1.5) % tr.L - tr.L / 2)).toBeLessThan(1.5);
    }
    // the grass beyond the far wall is grass, and out
    const far = lanePoint(l, l.box, laneValue(l, l.wOut, l.box) + 3);
    expect(laneAt(l, far.x, far.z, lp)).toBe(false);
    if (!pitFootprint(l, far.x, far.z)) { wheelGround(tr, far.x, far.z, -1, p, res); expect(res.surf === S_ASPHALT && Math.abs(p.lat) > (p.lat > 0 ? tr.WL : tr.WR)[p.i]).toBe(false); }
    // the LibreCorsa engine's walls have the lane's: no way from the track's middle into the lane between the walls'
    // ends without crossing one
    const walls = trackWalls(tr), ids = new Int32Array(4096), s = walls.segments;
    for (let k = l.kNose + 15; k <= l.kTail - 15; k += 5) {
      const i = l.I[k], ax = tr.X[i], az = tr.Z[i], bx = l.X[k], bz = l.Z[k], mx = (ax + bx) / 2, mz = (az + bz) / 2, r = Math.hypot(bx - ax, bz - az) / 2 + 1;
      const n = walls.near(mx, mz, r, ids);
      let crossed = false;
      for (let j = 0; j < n && !crossed; j++) { const o = ids[j] * 6; crossed = segX(ax, az, bx, bz, s[o], s[o + 1], s[o + 2], s[o + 3]); }
      expect(crossed, `${id}: a way in ${l.D[k].toFixed(0)} m along`).toBe(true);
    }
    // timing: where the lane passes a timing line it has its own segment, which the track's does not overlap
    const t = new Timing(tr, 'test.key');
    for (const ln of t.lines) {
      const sPass = laneLapS(l, tr.L, 0), span = ((ln.s - sPass) % tr.L + tr.L) % tr.L < ((laneLapS(l, tr.L, l.len) - sPass) % tr.L + tr.L) % tr.L;
      expect(ln.segs.length).toBe(span ? 2 : 1);
      if (span) {
        const [a, b] = ln.segs;
        expect(segX(a.ax, a.az, a.bx, a.bz, b.ax, b.az, b.bx, b.bz)).toBe(false);
        expect(laneAt(l, (b.ax + b.bx) / 2, (b.az + b.bz) / 2, lp)).toBe(true);
      }
    }
    // the box and the one-shot waiting spots (a full room) on the lane, in the working lane; placements there land on
    // the point, facing down the lane
    for (const d of [l.box, ...Array.from({ length: 32 }, (_, k) => waitingSpot(l, k, 32))]) {
      expect(d).toBeGreaterThanOrEqual(l.work[0]); expect(d).toBeLessThanOrEqual(l.work[1]);
      const q = lanePoint(l, d, l.boxOff), pl = lanePlacement(tr, l, d, l.boxOff), at = pointAt(tr, pl.s, pl.lat);
      expect(Math.hypot(at.x - q.x, at.z - q.z), `${id}: placed ${d.toFixed(0)} m along`).toBeLessThan(0.05);
      const yaw = Math.atan2(tr.TX[at.i], tr.TZ[at.i]) + pl.heading;
      expect(Math.sin(yaw) * q.tx + Math.cos(yaw) * q.tz).toBeGreaterThan(0.999);
      expect(laneAt(l, q.x, q.z, lp) && Math.abs(lp.off - l.boxOff) < PIT.boxWidth / 2).toBe(true);
    }
  });

  test.each(IDS)('%s: the start gantry stands clear of the lane, on the pit wall or beyond the lane', async (id) => {
    const def = TRACKS[id], tr = await trackFor(id), l = tr.pit!, { wl, wr } = gantryPosts(tr, def), lp: LanePos = { d: 0, off: 0, k: 0 };
    const pit = def.pitSide > 0 ? wl : wr, other = def.pitSide > 0 ? wr : wl, half = GANTRY_POST / 2;
    expect(other).toBeCloseTo((def.pitSide > 0 ? tr.WR[0] : tr.WL[0]) + 2, 6);
    for (const o of [pit - half + 0.05, pit, pit + half - 0.05]) {
      const x = tr.X[0] + tr.NX[0] * def.pitSide * o, z = tr.Z[0] + tr.NZ[0] * def.pitSide * o;
      expect(laneAt(l, x, z, lp), `${id}: the post on the lane`).toBe(false);
    }
    expect(pit - half).toBeGreaterThan((def.pitSide > 0 ? tr.WL[0] : tr.WR[0]) + 1);
  });
});
