import { writeSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { CarId } from '../src/cars';
import type { CompoundId, Conditions } from '../src/conditions';
import { session } from './harness';
import { setWear } from './tyres';

// The tyre numbers a race's length and wear-scale options are chosen from: `TYRES='wear lcf1' npm run tyres:report`
// (what: wear, life or wet; cars: lcf1, lcgt3, drift; several words run several parts, one after another, so run
// several shells for many). Skipped without TYRES. Every lap is the autopilot's at Melbourne from the game's flying
// start, which plans with the grip the car reports (Vehicle.gripPlan), so the times are the autopilot's response to
// the grip lost.
//  - wear: lap time against tyre wear. Every wheel's wear is set (0, 0.25, 0.5, 0.75, 1) with wear itself off, so the
//    lap is driven on tyres worn that much throughout; the lap-time loss per unit of wear is the slope.
//  - life: the wear a lap adds at wear scale 1 (three laps from fresh tyres at the heat of a lap: per lap, the most
//    worn wheel and the mean), so laps until finished = 1 / the most worn wheel's wear a lap, and the loss per lap =
//    that wear a lap x the slope from `wear` (wear grows about linearly with distance at a steady pace). The rain
//    tyres also on a track wet enough for them (0.4 the intermediate, 0.8 the wet), where they wear less.
//  - wet: lap times on the softest slick, the intermediate and the wet at track wetness 0 .. 1, second lap of two (the
//    first lets the tyres reach the wet's heat), wear off.
const ASK = (process.env.TYRES ?? '').split(/[\s,]+/).filter(Boolean);
const print = (s: string) => writeSync(1, s + '\n');
const lcCompounds = (car: CarId): CompoundId[] => car === 'drift' ? ['allweather'] : ['soft', 'medium', 'hard', 'intermediate', 'wet'];

// n laps from the flying start (placed again in these conditions, so at their start speed), after `then`.
async function laps(carId: CarId, compound: CompoundId, n: number, conditions: Partial<Conditions>, then?: (s: Awaited<ReturnType<typeof session>>) => void) {
  const h = await session(carId, { flying: true });
  h.session.setConditions(conditions);
  if (compound !== h.car.compound.id) h.car.fitTyres(compound, 'lap');
  h.session.restart();
  then?.(h);
  let resets = 0;
  h.session.onReset = () => { resets++; };
  const out: { time: number; valid: boolean; wearMax: number; wearMean: number }[] = [];
  let prev = h.car.tyreWear.slice();
  for (let k = 0; k < n; k++) {
    h.drive(300, null, () => h.timing.laps.length > k);
    const w = h.car.tyreWear, d = w.map((x, i) => x - prev[i]);
    out.push({ time: h.timing.laps[0]?.time ?? NaN, valid: h.timing.laps[0]?.valid ?? false, wearMax: Math.max(...d), wearMean: d.reduce((a, b) => a + b) / 4 });
    prev = w.slice();
  }
  return { out, resets };
}

describe.skipIf(ASK.length === 0)('tyre report', () => {
  const parts = ASK.filter((a) => ['wear', 'life', 'wet'].includes(a)), cars = ASK.filter((a) => ['lcf1', 'lcgt3', 'drift'].includes(a)) as CarId[];
  for (const part of parts) for (const car of cars) it(`${part} ${car}`, async () => {
    if (part === 'wear') for (const c of lcCompounds(car)) {
      const row: string[] = [];
      for (const w of [0, 0.25, 0.5, 0.75, 1]) {
        const r = await laps(car, c, 1, {}, (h) => setWear(h, w));
        row.push(`${w}: ${r.out[0].time.toFixed(3)}${r.out[0].valid ? '' : '*'}${r.resets ? ` (${r.resets} resets)` : ''}`);
      }
      print(`wear ${car} ${c}  ${row.join('  ')}`);
    }
    if (part === 'life') for (const [c, wetness] of lcCompounds(car).flatMap((c) => [[c, 0], ...(c === 'intermediate' ? [[c, 0.4]] : c === 'wet' ? [[c, 0.8]] : [])] as [CompoundId, number][])) {
      const r = await laps(car, c, 3, { wearScale: 1, wetness });
      print(`life ${car} ${c}${wetness ? ` wet ${wetness}` : ''}  ${r.out.map((l) => `${l.time.toFixed(3)}${l.valid ? '' : '*'} max ${(l.wearMax * 100).toFixed(2)}% mean ${(l.wearMean * 100).toFixed(2)}%`).join('  |  ')}${r.resets ? ` (${r.resets} resets)` : ''}`);
    }
    if (part === 'wet') for (const c of (car === 'drift' ? ['allweather'] : ['soft', 'intermediate', 'wet']) as CompoundId[]) {
      const row: string[] = [];
      for (const wet of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
        const r = await laps(car, c, 2, { wetness: wet });
        row.push(`${wet}: ${r.out[1].time.toFixed(3)}${r.out[1].valid ? '' : '*'}${r.resets ? `(${r.resets}R)` : ''}`);
      }
      print(`wet ${car} ${c}  ${row.join('  ')}`);
    }
  }, 3_600_000);
});
