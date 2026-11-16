import { writeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARS, type CarId } from '../src/cars';
import type { Track } from '../src/track';
import { TRACKS, type TrackDef, type TrackId } from '../src/tracks';
import { wrapI } from '../src/util';
import { session, trackFor } from './harness';

// Where each circuit's flying start goes, and each car's speed there: `FLYING=monza npm run tracks:flying` (several
// circuits separated by spaces or commas, or `all`: about 12 s of computing per lap, three laps a circuit). Skipped
// without FLYING. It drives every car's autopilot lap from the current start and prints, per circuit, the TrackDef
// line to use (startBack and flying) with the run-up time, and the lap times from the current start.
//
// The start spot, by rule: walking back from the line, past the last real corner (radius 150 m or less), to the first
// straight (radius 300 m or more) at least 40 m long. The car starts on that straight, 1 s of the GT3's travel before
// it brakes there (where it is fastest on it), and at least 15 m inside the straight's far end. So the run-up covers
// the last corner, or the corners that follow each other too closely to start between, and the start is not in a
// braking zone. A circuit with `startManual` keeps its own startBack (the rule's spot is printed for comparison).
// The flying speeds are each car's speed passing that spot at the end of its lap (what test/laps.ts checks).
const RULE = { corner: 150, straight: 300, run: 40, lead: 1, inset: 15 };

type Pass = { s: number; v: number; t: number };   // a tick of the end of the lap: where, km/h, sim time

// The rule's start spot (m before the line), from the GT3's passes over the end of its lap.
export function ruleStart(tr: Track, gt3: Pass[]): number {
  const ds = tr.L / tr.N, back = (k: number) => wrapI(-k, tr.N);   // k samples before the line
  let k = 1;
  while (Math.abs(tr.KS[back(k)]) < 1 / RULE.corner) k++;
  for (;;) {
    while (Math.abs(tr.KS[back(k)]) >= 1 / RULE.straight) k++;
    const near = k;
    while (Math.abs(tr.KS[back(k)]) < 1 / RULE.straight) k++;
    const from = near * ds, to = (k - 1) * ds - RULE.inset;   // m before the line, nearest the line first
    if (to - from + RULE.inset < RULE.run) continue;
    const on = gt3.filter((p) => tr.L - p.s >= from && tr.L - p.s <= to);
    const brake = on.reduce((a, p) => (p.v > a.v ? p : a));
    const lead = on.filter((p) => p.t <= brake.t && brake.t - p.t <= RULE.lead);
    return Math.round(tr.L - lead[0].s);
  }
}

const want = process.env.FLYING;
const ids = (want === 'all' ? Object.keys(TRACKS) : (want ?? '').split(/[\s,]+/).filter(Boolean)) as TrackId[];

describe.runIf(want)('flying starts', () => {
  for (const id of ids) {
    it(id, { timeout: 600_000 }, async () => {
      const def: TrackDef = TRACKS[id], tr = await trackFor(id);
      expect(def, `no circuit ${id}`).toBeDefined();
      const passes = {} as Record<CarId, Pass[]>, laps = {} as Record<CarId, string>, lapEnd = {} as Record<CarId, number>;
      for (const car of Object.keys(CARS) as CarId[]) {
        const { timing, drive, car: c, session: s } = await session(car, { track: id, flying: true });
        const out: Pass[] = passes[car] = [];
        drive(300, null, () => {
          if (timing.lapStart != null && s.simTime - timing.lapStart > 10 && c.proj.s > tr.L - 3000) out.push({ s: c.proj.s, v: c.speedF * 3.6, t: s.simTime });
          return timing.laps.length > 0;
        });
        const lap = timing.laps[0];
        laps[car] = lap ? `${lap.time.toFixed(3)}${lap.valid ? '' : ' (invalid)'}` : 'none';
        lapEnd[car] = timing.lapStart ?? NaN;
      }
      const rule = ruleStart(tr, passes.lcgt3), back = def.startManual ? def.startBack : rule;
      const at = (car: CarId) => passes[car].find((p) => p.s >= tr.L - back);
      const flying = Object.keys(CARS).map((car) => `${car}: ${Math.round(at(car as CarId)?.v ?? NaN)}`).join(', ');
      const runup = Object.keys(CARS).map((car) => `${car} ${(lapEnd[car as CarId] - (at(car as CarId)?.t ?? NaN)).toFixed(1)} s`).join(', ');
      writeSync(1, `${id}: startBack: ${back}, flying: { ${flying} },` + (def.startManual ? `   (by hand; the rule says ${rule})` : '')
        + `\n  run-up ${runup}\n  laps from the current start (startBack ${def.startBack}): `
        + Object.entries(laps).map(([car, t]) => `${car} ${t}`).join(', ') + '\n');
    });
  }
});
