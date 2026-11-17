// A wet track (Conditions.wetness): loose bounds on what the LibreCorsa engine's water model, the cars' rain tyres and
// the drift car's grip scale should do over a stretch of the autopilot's lap (test/tyres.ts); the autopilot plans with
// the grip left (Vehicle.gripPlan). The crossovers measured over whole laps are in test/tyres-report.test.ts.
import { describe, expect, it } from 'vitest';
import { waterMm } from '../src/conditions';
import { LcCar } from '../src/lc/lcCar';
import { session } from './harness';
import { setWear, timedStretch } from './tyres';

describe('wet track', () => {
  it('costs a slick grip; the wet tyre beats it in the wet and loses to it in the dry', async () => {
    const soft = (await timedStretch('lcf1')).time;
    const softWet = await timedStretch('lcf1', { conditions: { wetness: 0.6 } });
    const wets = await timedStretch('lcf1', { compound: 'wet', conditions: { wetness: 0.6 } });
    const wetsDry = (await timedStretch('lcf1', { compound: 'wet' })).time;
    expect(softWet.time).toBeGreaterThan(soft * 1.15);
    expect(wets.resets).toBe(0);
    expect(wets.time).toBeLessThan(softWet.time);
    expect(wetsDry).toBeGreaterThan(soft);
  });

  it('can arrive mid-run: the engine has the water from the next tick and the autopilot slows for it', async () => {
    const h = await session('lcgt3', { flying: true }), v = () => (h.car as LcCar).vehicle;
    h.drive(4);
    expect(h.car.gripPlan()).toBeNull();
    h.session.setConditions({ rain: 1, wetness: 0.7 });
    expect(v().waterMm).toBe(waterMm(0.7));
    const plan = h.car.gripPlan();
    expect(plan?.at(30)).toBeLessThan(0.9);
    let resets = 0;
    h.session.onReset = () => { resets++; };
    h.drive(25);
    expect(resets).toBe(0);
    h.session.setConditions({ rain: 0, wetness: 0 });   // and dries again
    expect(v().waterMm).toBe(0);
    expect(h.car.gripPlan()).toBeNull();
  });
});

describe('drift car', () => {
  it('loses grip on worn tyres and in the wet, simply, and wears its tyres while it slides', async () => {
    const dry = (await timedStretch('drift')).time;
    const worn = await timedStretch('drift', { before: (h) => setWear(h, 1) });
    const wet = await timedStretch('drift', { conditions: { wetness: 0.8 } });
    expect(worn.time).toBeGreaterThan(dry + 0.3);
    expect(wet.resets).toBe(0);
    expect(wet.time).toBeGreaterThan(worn.time);
    const h = await session('drift', { flying: true });
    h.session.setConditions({ wearScale: 10 });
    h.drive(10);
    expect(h.car.wearing).toBe(true);
    for (const w of h.car.tyreWear) expect(w).toBeGreaterThan(0);
    expect(h.car.tyreWear[2] + h.car.tyreWear[3]).toBeGreaterThan(h.car.tyreWear[0] + h.car.tyreWear[1]);   // the rears slide
    h.car.fitTyres('allweather');
    expect(h.car.tyreWear).toEqual([0, 0, 0, 0]);
  });
});
