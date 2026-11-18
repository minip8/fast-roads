// Draws a circuit's pit lane as the game builds it (an SVG: the track and its barriers, the lane's road, the pit wall
// and the far wall, the limit lines, the box, the working stretch, the pit building, the grid and the start spot), for
// looking at: test/pitLanes.test.ts writes one per circuit when PITLANE_SVG names a folder.
import { gridSlots } from '../src/raceGeometry';
import { lanePoint, LANE, type PitLane } from '../src/pitLane';
import { pointAt, type Track } from '../src/track';
import type { TrackDef } from '../src/tracks';
import { wrapI } from '../src/util';

// view: a square r m either side of (x, z) instead of the whole lane and grid.
export function drawPitLane(tr: Track, def: TrackDef, extra: { x: number; z: number; colour: string }[] = [], view?: { x: number; z: number; r: number }): string {
  const l = tr.pit as PitLane;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  if (view) { minX = view.x - view.r; maxX = view.x + view.r; minZ = view.z - view.r; maxZ = view.z + view.r; }
  else {
    for (let k = 0; k < l.n; k++) { minX = Math.min(minX, l.X[k]); maxX = Math.max(maxX, l.X[k]); minZ = Math.min(minZ, l.Z[k]); maxZ = Math.max(maxZ, l.Z[k]); }
    for (let k = 0; k < 40; k++) { const p = pointAt(tr, tr.L - 8 - k * 8); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const m = 50; minX -= m; minZ -= m; maxX += m; maxZ += m;
  }
  const W = view ? 900 : 1800, sc = W / Math.max(maxX - minX, maxZ - minZ), H = Math.ceil((maxZ - minZ) * sc), Wd = Math.ceil((maxX - minX) * sc);
  const X = (x: number) => ((x - minX) * sc).toFixed(1), Y = (z: number) => ((z - minZ) * sc).toFixed(1);
  const inBox = (x: number, z: number) => x > minX - 30 && x < maxX + 30 && z > minZ - 30 && z < maxZ + 30;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${H + 40}" viewBox="0 -40 ${Wd} ${H + 40}" font-family="sans-serif">`,
    `<rect x="0" y="-40" width="${Wd}" height="${H + 40}" fill="#cfe3b8"/>`];
  const poly = (pts: [number, number][], attrs: string) => out.push(`<polygon points="${pts.map(([x, z]) => `${X(x)},${Y(z)}`).join(' ')}" ${attrs}/>`);
  const line = (pts: [number, number][], attrs: string) => out.push(`<polyline fill="none" points="${pts.map(([x, z]) => `${X(x)},${Y(z)}`).join(' ')}" ${attrs}/>`);
  const at = (i: number, lat: number): [number, number] => [tr.X[i] + tr.NX[i] * lat, tr.Z[i] + tr.NZ[i] * lat];
  // track road
  for (let i = 0; i < tr.N; i++) {
    const j = (i + 1) % tr.N;
    if (!inBox(tr.X[i], tr.Z[i])) continue;
    poly([at(i, tr.WL[i]), at(j, tr.WL[j]), at(j, -tr.WR[j]), at(i, -tr.WR[i])], 'fill="#6b6b6b" stroke="#6b6b6b" stroke-width="0.6"');
  }
  // lane road
  for (let k = 0; k + 1 < l.n; k++) {
    const p = (j: number, o: number): [number, number] => [l.X[j] + l.side * l.NX[j] * o, l.Z[j] + l.side * l.NZ[j] * o];
    const fill = k * 2 < l.limIn || k * 2 > l.limOut ? '#8a8a96' : '#80808c';
    poly([p(k, -l.wIn[k]), p(k + 1, -l.wIn[k + 1]), p(k + 1, l.wOut[k + 1]), p(k, l.wOut[k])], `fill="${fill}" stroke="${fill}" stroke-width="0.6"`);
  }
  // barriers (valid runs)
  for (const side of [1, -1]) {
    const off = side > 0 ? tr.barL : tr.barR, valid = side > 0 ? tr.barLValid : tr.barRValid;
    let run: [number, number][] = [];
    for (let i = 0; i <= tr.N; i++) {
      const j = i % tr.N;
      if (valid[j] && inBox(tr.X[j], tr.Z[j])) run.push(at(j, side * off[j]));
      else { if (run.length > 1) line(run, 'stroke="#b22" stroke-width="2"'); run = []; }
    }
    if (run.length > 1) line(run, 'stroke="#b22" stroke-width="2"');
  }
  // the lane's walls
  const pts = (pl: Float64Array): [number, number][] => { const r: [number, number][] = []; for (let j = 0; j + 1 < pl.length; j += 2) r.push([pl[j], pl[j + 1]]); return r; };
  poly([...pts(l.walls.lane), ...pts(l.walls.track).reverse()], 'fill="#222" stroke="#000" stroke-width="1"');
  for (const j of l.walls.joins) line(pts(j), 'stroke="#00f" stroke-width="2"');
  line(pts(l.walls.outer), 'stroke="#000" stroke-width="2.5"');
  // the path, limit lines, box, working stretch
  line(Array.from({ length: l.n }, (_, k) => [l.X[k], l.Z[k]] as [number, number]), 'stroke="#fff" stroke-width="0.8" stroke-dasharray="4 4"');
  const across = (d: number, colour: string, w = 3) => { const a = lanePoint(l, d, -LANE.fast / 2), b = lanePoint(l, d, LANE.fast / 2 + LANE.work); line([[a.x, a.z], [b.x, b.z]], `stroke="${colour}" stroke-width="${w}"`); };
  across(l.limIn, '#fff'); across(l.limOut, '#fff');
  const bx = lanePoint(l, l.box, l.boxOff);
  out.push(`<circle cx="${X(bx.x)}" cy="${Y(bx.z)}" r="${(3 * sc).toFixed(1)}" fill="#ffd23f" stroke="#000"/>`);
  const w0 = lanePoint(l, l.work[0], LANE.fast / 2 + LANE.work + 0.5), w1 = lanePoint(l, l.work[1], LANE.fast / 2 + LANE.work + 0.5);
  line([[w0.x, w0.z], [w1.x, w1.z]], 'stroke="#7a3fc0" stroke-width="3" stroke-dasharray="8 4"');
  for (const d of [l.nose, l.tail]) { const p = lanePoint(l, d, -LANE.fast / 2); out.push(`<circle cx="${X(p.x)}" cy="${Y(p.z)}" r="5" fill="none" stroke="#f0f" stroke-width="2"/>`); }
  if (l.building) {
    const b = l.building, c = (u: number, v: number): [number, number] => [b.x + b.ax * u + b.nx * v, b.z + b.az * u + b.nz * v];
    poly([c(-b.halfLen, -b.depth / 2), c(b.halfLen, -b.depth / 2), c(b.halfLen, b.depth / 2), c(-b.halfLen, b.depth / 2)], 'fill="#e8a33d" fill-opacity="0.8" stroke="#a60"');
  }
  // the grid, the start spot, the line
  for (const g of gridSlots(tr, 32)) { const p = pointAt(tr, g.s, g.lat); out.push(`<circle cx="${X(p.x)}" cy="${Y(p.z)}" r="2.5" fill="#fff"/>`); }
  const sp = pointAt(tr, tr.L - def.startBack);
  out.push(`<circle cx="${X(sp.x)}" cy="${Y(sp.z)}" r="6" fill="#2a2"/>`);
  line([at(0, tr.WL[0]), at(0, -tr.WR[0])], 'stroke="#000" stroke-width="4"');
  for (const e of extra) out.push(`<circle cx="${X(e.x)}" cy="${Y(e.z)}" r="3" fill="${e.colour}"/>`);
  // direction arrows along the lap
  for (let s = 0; s < tr.L; s += 100) {
    const i = wrapI(Math.round((s / tr.L) * tr.N), tr.N);
    if (!inBox(tr.X[i], tr.Z[i])) continue;
    const a = at(i, 0), b: [number, number] = [a[0] + tr.TX[i] * 8, a[1] + tr.TZ[i] * 8];
    line([a, b], 'stroke="#2a2" stroke-width="2"');
  }
  out.push(`<text x="8" y="-14" font-size="20">${def.id}: lane ${l.len.toFixed(0)} m, side ${l.side > 0 ? 'left' : 'right'}, nose ${l.nose.toFixed(0)} m, limit ${l.limIn.toFixed(0)}-${l.limOut.toFixed(0)} m, box ${l.box.toFixed(0)} m, tail ${l.tail.toFixed(0)} m (scale ${(100 * sc).toFixed(0)} px per 100 m)</text>`);
  out.push('</svg>');
  return out.join('\n');
}
