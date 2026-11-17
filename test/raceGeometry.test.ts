// The race weekend's geometry at every circuit (src/raceGeometry.ts): the starting grid for a full room and the pit
// lane, both from the track alone.
import { describe, expect, test } from 'vitest';
import { S_ASPHALT } from '../src/config';
import { buildPitLane, enablePitLane, gridSlots, GRID, laneLimit, laneZone, PIT } from '../src/raceGeometry';
import { pointAt, projectOnTrack, surfaceAt, trackLimitOut, type TrackPos } from '../src/track';
import { TRACKS, type TrackId } from '../src/tracks';
import { wrapI } from '../src/util';
import { trackFor } from './harness';

const IDS = Object.keys(TRACKS) as TrackId[];
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

describe('the pit lane', () => {
  test.each(IDS)('%s: along the pit side, within the walls, clear of the rest of the circuit', async (id) => {
    const def = TRACKS[id], tr = await trackFor(id), lane = buildPitLane(tr, def), ds = tr.L / tr.N;
    expect(lane.side).toBe(def.pitSide);
    expect(lane.limOut - lane.limIn).toBeGreaterThan(80);
    expect(lane.box).toBeGreaterThan(lane.limIn + PIT.boxLen); expect(lane.box).toBeLessThan(lane.limOut - PIT.boxLen);
    const bar = def.pitSide > 0 ? tr.barL : tr.barR, valid = def.pitSide > 0 ? tr.barLValid : tr.barRValid;
    const W = (i: number) => tr.WL[i] + tr.WR[i];
    let maxInto = 0;
    for (let k = 0; k < lane.n; k++) {
      const i = wrapI(lane.k0 + k, tr.N);
      expect(lane.outer[k] - lane.inner[k]).toBeCloseTo(PIT.width, 6);
      if (valid[i]) expect(lane.outer[k], `${id} lane sample ${k}`).toBeLessThanOrEqual(bar[i] - PIT.wallGap + 1e-6);
      expect(lane.inner[k] - lane.edge[k]).toBeLessThanOrEqual(PIT.trackGap + 1e-6);
      maxInto = Math.max(maxInto, lane.edge[k] - lane.inner[k]);
      // at most 2 m of the road, leaving at least 7 m of it to race on
      expect(lane.edge[k] - lane.inner[k]).toBeLessThan(2);
      expect(W(i) - Math.max(0, lane.edge[k] - lane.inner[k])).toBeGreaterThan(7);
      expect(Math.abs(tr.KS[i])).toBeLessThan(1 / 25);
      // no other part of the circuit is nearer to the lane than its own stretch
      for (const x of [lane.inner[k], lane.outer[k]]) {
        const o = x * lane.side, px = tr.X[i] + tr.NX[i] * o, pz = tr.Z[i] + tr.NZ[i] * o;
        const q = projectOnTrack(tr, px, pz, -1, { i: 0, s: 0, lat: 0 });
        expect(Math.abs(wrapI(q.i - i + tr.N / 2, tr.N) - tr.N / 2) * ds, `${id} lane sample ${k}`).toBeLessThan(30);
      }
    }
    // the start spot (where restarts put cars, rolling fast) is not in the lane's stretch
    const k0s = wrapI(Math.round((tr.L - def.startBack) / ds) - lane.k0, tr.N);
    expect(k0s >= lane.n).toBe(true);
    if (process.env.NET_REPORT) console.log(`${id}: lane ${lane.len.toFixed(0)} m (limit ${(lane.limOut - lane.limIn).toFixed(0)} m), ${maxInto > 0 ? `${maxInto.toFixed(2)} m into the track` : 'on the run-off'}`);
  });

  test('asphalt and inside the track limits only while enabled; the limiter and the zones', async () => {
    const tr = await trackFor('melbourne'), lane = buildPitLane(tr, TRACKS.melbourne), res = { surf: 0, h: 0 };
    const k = Math.round(lane.box / (tr.L / tr.N)), i = wrapI(lane.k0 + k, tr.N), mid = lane.side * (lane.inner[k] + lane.outer[k]) / 2;
    const before = surfaceAt(tr, i, mid, tr.S[i], res);
    expect(before).not.toBe(S_ASPHALT);
    expect(trackLimitOut(tr, i, mid)).toBe(true);
    enablePitLane(tr, lane);
    expect(surfaceAt(tr, i, mid, tr.S[i], res)).toBe(S_ASPHALT);
    expect(trackLimitOut(tr, i, mid)).toBe(false);
    expect(trackLimitOut(tr, i, -mid)).toBe(true);   // the other side is as it was
    const p: TrackPos = { i, s: tr.S[i], lat: mid };
    expect(laneZone(lane, tr, p)).toBe('lane');
    expect(laneZone(lane, tr, { ...p, lat: 0 })).toBe('track');
    enablePitLane(tr, null);
    expect(surfaceAt(tr, i, mid, tr.S[i], res)).toBe(before);
    expect(laneLimit(lane, lane.box)).toBeCloseTo(80 / 3.6, 6);
    expect(laneLimit(lane, 0)).toBeGreaterThan(80 / 3.6 + 10);
    expect(laneLimit(lane, lane.limOut + 1)).toBe(Infinity);
  });
});
