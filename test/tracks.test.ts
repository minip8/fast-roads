import { expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { CARS, type CarId } from '../src/cars';
import { circuitInfo, outlineOf, type Outline } from '../src/catalog';
import { clearOf, pitBuilding, standBays } from '../src/scenery';
import { blockSpots, bridgeSpots, MAST_RADIUS, mastSpots, TREE_RADIUS, treeSpots } from '../src/trackside';
import { S_ASPHALT } from '../src/config';
import { edgeLine, laneAt, laneValue, type LanePos } from '../src/pitLane';
import { laneWalls, parseCSV, surfaceAt } from '../src/track';
import { OUTLINES } from '../src/trackOutlines';
import { loadTrackCsv, TRACKS } from '../src/tracks';
import { wrapI } from '../src/util';
import { trackFor } from './harness';

// Cheap checks of every circuit's data (the autopilot laps are in laps-*.test.ts and, for most circuits,
// npm run test:laps).
for (const def of Object.values(TRACKS)) {
  it(`${def.id}: the right length, its own best-times key, a start spot before the last corner, walls and buildings`, async () => {
    const tr = await trackFor(def.id), ds = tr.L / tr.N;
    // the lap is as long as the real one (catches a projection or scale mistake in scripts/tracks/convert.mjs)
    expect(Math.abs(tr.L / 1000 / def.lengthKm - 1)).toBeLessThan(0.015);
    expect(Object.values(TRACKS).filter((t) => t.storeKey === def.storeKey)).toHaveLength(1);
    // the start spot: before at least one corner (radius 250 m or less: Baku's last braking corner, smoothed, is about
    // 210 m; elsewhere the rule puts it before one of 150 m or less) and within reach of the line, on a straight (radius 250 m or more for 5 m either side: the car is put there at speed, pointing along
    // the road), on the asphalt, between walls
    const at = Math.round(def.startBack / ds), runup = Array.from({ length: at }, (_, k) => tr.KS[wrapI(-k, tr.N)]);
    expect(Math.max(...runup.map(Math.abs))).toBeGreaterThan(1 / 250);
    expect(def.startBack).toBeLessThan(1200);
    for (let k = at - 3; k <= at + 3; k++) expect(Math.abs(tr.KS[wrapI(-k, tr.N)]), `${def.id}: start spot curvature`).toBeLessThan(1 / 250);
    const spot = wrapI(-at, tr.N);
    expect([tr.WL[spot] > 4, tr.WR[spot] > 4, !!tr.barLValid[spot], !!tr.barRValid[spot]]).toEqual([true, true, true, true]);
    expect(surfaceAt(tr, spot, 0, tr.S[spot], { surf: 0, h: 0 })).toBe(S_ASPHALT);
    // a flying-lap speed for every car
    for (const car of Object.keys(CARS) as CarId[]) expect(def.flying[car]).toBeGreaterThan(60);
    // walls on both sides all the way round, except where another part of the circuit runs through (Suzuka's
    // crossover, the other side of a hairpin): there the wall would stand on the other road; and at the pit lane's
    // openings, which test/raceGeometry.test.ts checks (the lane's own walls close them)
    const lane = tr.pit!, gaps = (i: number) => { const s = ((tr.S[i] - lane.sStart) % tr.L + tr.L) % tr.L; return s < laneValue(lane, lane.S, lane.len) - lane.S[0]; };
    for (const [side, valid] of [[1, tr.barLValid], [-1, tr.barRValid]] as const) {
      for (let i = 0; i < tr.N; i++) {
        if (valid[i] || (side === lane.side && gaps(i))) continue;
        let near = Infinity;
        for (let j = 0; j < tr.N; j++) {
          const apart = Math.abs(tr.S[i] - tr.S[j]);
          if (Math.min(apart, tr.L - apart) > 20) near = Math.min(near, Math.hypot(tr.X[i] - tr.X[j], tr.Z[i] - tr.Z[j]));
        }
        expect(near, `${def.id}: no wall at s = ${tr.S[i].toFixed(0)}`).toBeLessThan(40);
      }
    }
    // the pit building and grandstands fit beside the lane and the straight without reaching another part of the
    // circuit (none at Monaco, whose lane runs between the start straight and the Swimming Pool: no room behind it)
    const pit = pitBuilding(tr);
    if (def.id === 'monaco') expect(pit).toBeNull();
    else expect(pit?.len).toBeGreaterThan(Math.min(150, 0.4 * (lane.work[1] - lane.work[0])));
    expect(standBays(tr, def).length).toBeGreaterThanOrEqual(Math.min(4, def.stands[0] + def.stands[1] + 1));
  });

  it(`${def.id}: scenery beyond the walls, clear of the track, of other stretches and of the pit lane's ground, the same every time`, async () => {
    const tr = await trackFor(def.id);
    // Independently of clearOf: no point of anything solid inside a stretch's walls (at the side of a centreline
    // sample, nearer than its barrier), nor on or within its reach of the pit lane (its road, the gores at its
    // openings, its walls and its building: wherever it runs, across the infield too).
    const ds = tr.L / tr.N, lane = tr.pit!, lp: LanePos = { d: 0, off: 0, k: 0 };
    const lines = [edgeLine(lane, 'in'), edgeLine(lane, 'out'), ...laneWalls(lane).map(([pl]) => pl)];
    const onLane = (x: number, z: number, r: number) => {
      if (laneAt(lane, x, z, lp)) return true;
      const b = lane.building;
      if (b) { const dx = x - b.x, dz = z - b.z; if (Math.abs(dx * b.ax + dz * b.az) < b.halfLen + r && Math.abs(dx * b.nx + dz * b.nz) < b.depth / 2 + r) return true; }
      for (const pl of lines) for (let j = 0; j + 3 < pl.length; j += 2) {
        const ax = pl[j], az = pl[j + 1], ex = pl[j + 2] - ax, ez = pl[j + 3] - az, l2 = ex * ex + ez * ez;
        if (Math.abs(x - ax) > 60 || Math.abs(z - az) > 60) continue;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
        if (Math.hypot(ax + t * ex - x, az + t * ez - z) < r) return true;
      }
      return false;
    };
    // the samples within 150 m of a thing (found once for all its points)
    const nearby = (x: number, z: number) => { const out: number[] = []; for (let j = 0; j < tr.N; j++) if ((x - tr.X[j]) ** 2 + (z - tr.Z[j]) ** 2 < 22500) out.push(j); return out; };
    const inWalls = (x: number, z: number, r: number, near = nearby(x, z)) => {
      for (const j of near) {
        const dx = x - tr.X[j], dz = z - tr.Z[j];
        if (dx * dx + dz * dz > 6400 || Math.abs(dx * tr.TX[j] + dz * tr.TZ[j]) > ds) continue;
        const lat = dx * tr.NX[j] + dz * tr.NZ[j], bar = lat > 0 ? tr.barL[j] : tr.barR[j];
        if (Math.abs(lat) < bar + r) return `inside the walls at s = ${tr.S[j].toFixed(0)}`;
      }
      return onLane(x, z, r) ? 'on the pit lane' : null;
    };
    const trees = treeSpots(tr, def);
    expect(trees.length).toBeGreaterThan(0.5 * def.trees);
    for (const t of trees) expect(inWalls(t.x, t.z, TREE_RADIUS - 0.5), `${def.id}: a ${t.kind} tree`).toBeNull();
    const masts = mastSpots(tr, def);
    expect(masts.length).toBeGreaterThan(tr.L / 250);
    for (const m of masts) expect(inWalls(m.x, m.z, MAST_RADIUS - 0.5), `${def.id}: a mast`).toBeNull();
    const blocks = blockSpots(tr, def);
    if (def.scene === 'city') expect(blocks.length).toBeGreaterThan(tr.L / 100);
    for (const b of blocks) {
      // the footprint's points are at most 2.5 m apart all over it, so no road passes between them
      expect(b.pts.length).toBeGreaterThanOrEqual((Math.ceil(b.w / 2.5) + 1) * (Math.ceil(b.d / 2.5) + 1));
      const near = nearby(b.x, b.z);
      for (const [x, z] of b.pts) expect(inWalls(x, z, 1, near), `${def.id}: a building`).toBeNull();
    }
    for (const b of bridgeSpots(tr, def)) {
      for (const [x, z] of b.legs) expect(inWalls(x, z, 0.1), `${def.id}: a bridge's leg`).toBeNull();
      // its deck crosses this stretch only
      for (const [x, z] of b.deck) expect(clearOf(tr, def, [[x, z]], { skip: [b.i - 60, b.i + 60], margin: 1 })).toBe(true);
      for (const [x, z] of b.deck) expect(onLane(x, z, 1), `${def.id}: a bridge over the pit lane`).toBe(false);
    }
    // the stands too
    for (const b of standBays(tr, def)) expect(onLane(b.x, b.z, 8), `${def.id}: a stand`).toBe(false);
    // deterministic: every client and every reload places the same
    expect(treeSpots(tr, def)).toEqual(trees);
    expect(blockSpots(tr, def)).toEqual(blocks);
  });
}

// The menu draws each circuit from src/trackOutlines.ts, because only the driven circuit's CSV is loaded.
// npm run tracks:outlines rewrites that file from the CSVs; this fails when it is out of date.
it('has an up-to-date menu outline for every circuit', async () => {
  const fresh: Record<string, Outline> = {};
  for (const def of Object.values(TRACKS)) fresh[def.id] = outlineOf(parseCSV(await loadTrackCsv(def.id)));
  if (process.env.UPDATE_OUTLINES) {
    const rows = Object.entries(fresh).map(([id, o]) => `  ${id}: { path: '${o.path}', start: [${o.start.join(', ')}] },`);
    writeFileSync(new URL('../src/trackOutlines.ts', import.meta.url),
      `// Generated from tracks/*.csv by npm run tracks:outlines. Do not edit.\nimport type { Outline } from './catalog';\nimport type { TrackId } from './tracks';\n\nexport const OUTLINES: Record<TrackId, Outline> = {\n${rows.join('\n')}\n};\n`);
    return;
  }
  expect(OUTLINES).toEqual(fresh);
  for (const def of Object.values(TRACKS)) {
    const info = circuitInfo(def), nums = info.outline.match(/-?[\d.]+/g)!.map(Number);
    expect(nums.length).toBeGreaterThan(100);
    expect(nums.every((v) => v >= 0 && v <= 100)).toBe(true);
  }
});

it('lists the circuits in calendar order, Melbourne first', () => {
  const rounds = Object.values(TRACKS).map((t) => t.round).filter((r) => r != null);
  expect(rounds).toEqual(rounds.map((_, k) => k + 1));
  expect(Object.keys(TRACKS)[0]).toBe('melbourne');
});
