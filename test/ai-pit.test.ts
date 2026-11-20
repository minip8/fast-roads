import { describe, expect, it } from 'vitest';
import { pitOpen } from '../src/ai/pitOpen';
import { KERB_W } from '../src/config';
import { laneLapS } from '../src/pitLane';
import { inPitLane, pointAt, projectOnTrack, type TrackPos } from '../src/track';
import { TRACKS, type TrackId } from '../src/tracks';
import { trackFor } from './harness';

// The observation's pit-lane flags (src/ai/pitOpen.ts) against a brute-force search at every circuit: wherever a car's
// centre beside the track would be in the pit lane by the timing's own test (inPitLane: its lap deleted) on a stretch
// open to the track (not behind the pit wall, in front of the track's barrier), the nearest track sample has that side
// flagged. Geometry only.

const IDS = Object.keys(TRACKS) as TrackId[];
const STEP_S = 0.25, STEP_LAT = 0.1, MAX_PAST = 12;   // the search: m along the lap, m out from the edge (to 4 m; 0.25 m beyond), how far out

describe('pit lane flags', () => {
  it('flag every stretch where the open pit lane adjoins the track, at every circuit (no misses)', async () => {
    const rows: Record<string, string | number>[] = [];
    let build = 0;
    for (const id of IDS) {
      const tr = await trackFor(id), l = tr.pit!, g = l.grid, t0 = performance.now(), po = pitOpen(tr);
      build = Math.max(build, performance.now() - t0);
      const at = { d: 0 }, p: TrackPos = { i: -1, s: 0, lat: 0 };
      let hits = 0, misses = 0, onKerb = 0, deepest = 0, worst = '';
      for (let s = 0; s < tr.L; s += STEP_S) {
        const c = pointAt(tr, s);
        // (no point within MAX_PAST of the edge can be on the lane's road if the centreline is this far from its grid)
        if (c.x < g.minX - 60 || c.z < g.minZ - 60 || c.x > g.minX + g.nx * 8 + 60 || c.z > g.minZ + g.nz * 8 + 60) continue;
        const i = c.i, j = (i + 1) % tr.N, f = (s - tr.S[i]) / (tr.S[i + 1] - tr.S[i]);
        const nx = tr.NX[i] + (tr.NX[j] - tr.NX[i]) * f, nz = tr.NZ[i] + (tr.NZ[j] - tr.NZ[i]) * f;   // (as pointAt)
        for (const side of [1, -1] as const) {
          const W = side > 0 ? tr.WL : tr.WR, w = W[i] + (W[j] - W[i]) * f;
          for (let o = 0.02; o <= MAX_PAST; o += o < 4 ? STEP_LAT : 2.5 * STEP_LAT) {
            const x = c.x + side * nx * (w + o), z = c.z + side * nz * (w + o);
            if (!inPitLane(tr, x, z, i, at) || (at.d >= l.nose && at.d <= l.tail)) continue;
            projectOnTrack(tr, x, z, i, p);
            const left = p.lat > 0, bar = (left ? tr.barL : tr.barR)[p.i];
            if ((left ? tr.barLValid : tr.barRValid)[p.i] && Math.abs(p.lat) >= bar) continue;   // behind the barrier
            hits++;
            if ((left ? tr.kerbL : tr.kerbR)[p.i] && Math.abs(p.lat) - (left ? tr.WL : tr.WR)[p.i] < KERB_W) onKerb++;
            if (!(left ? po.left : po.right)[p.i]) {
              misses++;
              if (o > deepest) { deepest = o; worst = `s ${s.toFixed(1)} ${left ? 'L' : 'R'} +${o.toFixed(2)} m`; }
            }
          }
        }
      }
      const metres = (a: Uint8Array) => { let m = 0; for (let i = 0; i < tr.N; i++) if (a[i]) m += tr.S[i + 1] - tr.S[i]; return Math.round(m); };
      const stretches = (a: Uint8Array) => {
        const out: string[] = [];
        for (let i = 0; i < tr.N; i++) {
          if (!a[i] || a[(i - 1 + tr.N) % tr.N]) continue;
          let e = i; while (a[(e + 1) % tr.N] && (e + 1) % tr.N !== i) e = (e + 1) % tr.N;
          out.push(`${Math.round(tr.S[i])}-${Math.round(tr.S[e + 1])}`);
        }
        return out.join(' ');
      };
      const lap = (d: number) => Math.round(laneLapS(l, tr.L, d));
      rows.push({
        id, side: l.side > 0 ? 'L' : 'R', L: Math.round(tr.L), entry: lap(0), nose: lap(l.nose), tail: lap(l.tail), exit: lap(l.len),
        flagL: metres(po.left), flagR: metres(po.right), stretchesL: stretches(po.left), stretchesR: stretches(po.right),
        hits, onKerb, misses, worst,
      });
    }
    console.table(rows);
    console.log(`flags built in ${build.toFixed(0)} ms at most`);
    for (const r of rows) {
      expect(r.misses, `${r.id}: ${r.worst}`).toBe(0);
      expect(r.hits).toBeGreaterThan(0);
      // the flags are on the lane's side only
      expect(r.side === 'L' ? r.flagR : r.flagL).toBe(0);
    }
  }, 120_000);
});
