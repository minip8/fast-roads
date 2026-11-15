import { expect, it } from 'vitest';
import { buildTrack, parseCSV } from '../src/track';
import { TRACKS } from '../src/tracks';
import { wrapI } from '../src/util';

const LENGTH_KM = { melbourne: 5.30, silverstone: 5.89 };

for (const def of Object.values(TRACKS)) {
  it(`${def.id}: the right length, its own best-times key, and a straight grid`, () => {
    const tr = buildTrack(parseCSV(def.csv)), ds = tr.L / tr.N;
    expect(tr.L / 1000).toBeCloseTo(LENGTH_KM[def.id], 1);
    expect(Object.values(TRACKS).filter((t) => t.storeKey === def.storeKey)).toHaveLength(1);
    // the car starts on the straight, and stays on it to the line
    for (let k = 0; k <= Math.round(def.startBack / ds); k++) expect(Math.abs(tr.KS[wrapI(-k, tr.N)])).toBeLessThan(1 / 500);
    // walls all the way round on both sides
    expect(tr.barLValid.every((v) => v === 1) && tr.barRValid.every((v) => v === 1)).toBe(true);
  });
}
