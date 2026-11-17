// Tyre wear and compounds (conditions.ts, Vehicle.fitTyres / tyreWear): loose bounds on what the LibreCorsa engine's
// wear model and the cars' compound data should do, over a stretch of the autopilot's lap (test/tyres.ts). The
// measured numbers (lap times, wear a lap) are in test/tyres-report.test.ts.
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { normalizeConditions, TIME_TRIAL, waterMm } from '../src/conditions';
import { LcCar } from '../src/lc/lcCar';
import { session } from './harness';
import { setWear, stretch, timedStretch } from './tyres';

describe('time trial', () => {
  it('is the default, wears nothing and plans with the dry grip', async () => {
    for (const id of ['lcf1', 'lcgt3', 'drift'] as const) {
      const h = await session(id, { flying: true });
      expect(h.session.conditions).toEqual(TIME_TRIAL);
      expect(h.car.compound).toBe(h.car.compounds[0]);
      h.drive(5);
      expect(h.car.wearing).toBe(false);
      expect(h.car.tyreWear).toEqual([0, 0, 0, 0]);
      expect(h.car.gripPlan()).toBeNull();
      expect(h.car.tyres?.wheels.map((t) => t.wear)).toEqual(h.car.tyres ? [undefined, undefined, undefined, undefined] : undefined);
    }
  });
  it('keeps its best times apart from other conditions\' (the store tag)', async () => {
    const { session: s } = await session('lcf1');
    const key = s.timing.storeKey;
    s.setStoreTag('.race');
    expect(s.timing.storeKey).toBe(key + '.race');
    s.setCar(CARS.lcgt3);
    expect(s.timing.storeKey).toMatch(/\.lcgt3\.race$/);
  });
});

describe('conditions', () => {
  it('are clamped and keep what is not given', () => {
    expect(normalizeConditions({ wetness: 2, rain: -1, wearScale: Number.NaN }, { ...TIME_TRIAL, wearScale: 3 }))
      .toEqual({ ...TIME_TRIAL, wetness: 1, rain: 0, wearScale: 3 });
  });
  it('reach the LibreCorsa engine at once: water, temperatures and the wear rate', async () => {
    const h = await session('lcf1', { flying: true }), v = (h.car as LcCar).vehicle;
    h.session.setConditions({ wetness: 0.5, airC: 15, trackC: 20, wearScale: 2 });
    expect([v.waterMm, v.ambientC, v.trackTempC]).toEqual([waterMm(0.5), 15, 20]);
    expect(v.wetness).toBeGreaterThan(0.8);   // 0.75 mm of water acts nearly fully wet
    const spec = CARS.lcf1;
    if (spec.physics !== 'lc') throw new Error('lcf1 is a LibreCorsa car');
    expect(v.realism.tyreWearScale).toBe(2 * spec.compoundWear.soft!);   // the soft wears 1/0.65 as fast as the medium
    h.session.restart();   // a restart builds a new engine: it gets them too
    const w = (h.car as LcCar).vehicle;
    expect(w).not.toBe(v);
    expect([w.waterMm, w.ambientC, w.trackTempC]).toEqual([waterMm(0.5), 15, 20]);
  });
});

describe('wear', () => {
  it('accumulates on every wheel, faster on softer compounds, and is the same run after run', async () => {
    const wearAfter = async (id: 'lcf1' | 'lcgt3', compound: 'soft' | 'medium' | 'hard') => {
      const h = await session(id, { flying: true });
      h.session.setConditions({ wearScale: 10 });
      if (compound !== 'soft') h.car.fitTyres(compound, 'lap');
      h.drive(15);
      expect(h.car.wearing).toBe(true);
      expect(h.car.tyres!.wheels.map((t) => t.wear)).toEqual(h.car.tyreWear);
      return { wear: h.car.tyreWear.slice(), pos: h.car.pos.clone() };
    };
    for (const id of ['lcf1', 'lcgt3'] as const) {
      const [s, m, hd] = [await wearAfter(id, 'soft'), await wearAfter(id, 'medium'), await wearAfter(id, 'hard')];
      for (const w of s.wear) expect(w).toBeGreaterThan(0);
      const mean = (a: number[]) => a.reduce((x, y) => x + y) / 4;
      expect(mean(s.wear)).toBeGreaterThan(mean(m.wear) * 1.2);
      expect(mean(m.wear)).toBeGreaterThan(mean(hd.wear) * 1.2);
      if (id === 'lcf1') {   // deterministic with wear on: the same 15 s again, bit for bit
        const again = await wearAfter(id, 'soft');
        expect(again.wear).toEqual(s.wear);
        expect(again.pos.toArray()).toEqual(s.pos.toArray());
      }
    }
  });

  it('costs lap time, and a fresh set gives it back; a restart keeps the worn set while wear is on', async () => {
    for (const id of ['lcf1', 'lcgt3'] as const) {
      const fresh = await timedStretch(id);
      const worn = await timedStretch(id, { before: (h) => setWear(h, 0.6) });
      expect(worn.resets).toBe(0);
      expect(worn.time).toBeGreaterThan(fresh.time + 0.15);
      expect(worn.time).toBeLessThan(fresh.time * 1.1);
      // wear on: worn tyres stay worn through a restart, until a new set
      const { h } = worn;
      h.session.setConditions({ wearScale: 1 });
      setWear(h, 0.6);
      h.session.restart();
      expect(Math.min(...h.car.tyreWear)).toBeGreaterThanOrEqual(0.6);
      h.car.fitTyres('soft', 'lap');
      expect(h.car.tyreWear).toEqual([0, 0, 0, 0]);
      h.session.restart();
      expect(Math.max(...h.car.tyreWear)).toBeLessThan(0.001);
      const again = stretch(h);
      expect(Math.abs(again.time - fresh.time)).toBeLessThan(0.15);
    }
  });
});

describe('compounds', () => {
  it('are the data\'s, soft first: the F1 and the GT3 have three slicks and two rain tyres, the drift car one tyre', async () => {
    for (const id of ['lcf1', 'lcgt3'] as const) {
      const { car } = await session(id);
      expect(car.compounds.map((c) => `${c.id}:${c.letter}:${c.rain}`)).toEqual(['soft:S:false', 'medium:M:false', 'hard:H:false', 'intermediate:I:true', 'wet:W:true']);
    }
    const { car } = await session('drift');
    expect(car.compounds.map((c) => c.id)).toEqual(['allweather']);
    expect(() => car.fitTyres('soft')).toThrow(/no soft/);
  });

  it('fit fresh out of the blankets: the engine\'s blanket heat, the compound\'s window, the brake discs kept', async () => {
    const h = await session('lcf1', { flying: true });
    h.drive(8);
    const discs = h.car.tyres!.wheels.map((t) => t.brakeC);
    h.car.fitTyres('intermediate');
    expect(h.car.compound.id).toBe('intermediate');
    expect(h.car.tyres!.windowC[0][0]).toBeLessThan(80);            // the inter's window is 30 deg under the medium's
    for (const t of h.car.tyres!.wheels) expect(t.coreC).toBeLessThan(h.car.tyres!.windowC[0][0]);   // blankets: under the window
    expect(h.car.tyres!.wheels.map((t) => t.brakeC)).toEqual(discs);
  });

  it('differ in pace in the right order: soft, medium, hard', async () => {
    for (const id of ['lcf1', 'lcgt3'] as const) {
      const t = [];
      for (const compound of ['soft', 'medium', 'hard'] as const) t.push((await timedStretch(id, { compound })).time);
      expect(t[0]).toBeLessThan(t[1]);
      expect(t[1]).toBeLessThan(t[2]);
      expect(t[2] - t[0]).toBeLessThan(0.05 * t[0]);
    }
  });
});
