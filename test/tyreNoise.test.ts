// When the tyres squeal (audioGraph.ts tyreNoise, from VehicleWheel.slip): never with grip in hand, at the limit and
// past it, and not under ABS braking in a straight line unless the tyres really are past their peak. Each car is
// driven on open asphalt: a slow steering ramp at a held speed (quasi-steady cornering up to and past the car's
// limit), and full braking from speed. TYRE_NOISE_LOG=1 prints the measured numbers.
import { describe, expect, it } from 'vitest';
import { SQUEAL_SLIP, tyreNoise } from '../src/audioGraph';
import { CARS, type CarId } from '../src/cars';
import { S_ASPHALT, S_GRASS, S_KERB } from '../src/config';
import { compoundData } from '../src/lc/vendor/sim/f12026-car/F12026CarConfig';
import { createTyreRuntime } from '../src/lc/vendor/sim/f12026-car/VehiclePhysics';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { lc } from './lc-car';
import { session } from './harness';

const log = (...a: unknown[]) => { if (process.env.TYRE_NOISE_LOG) console.log(...a); };
const wheel = (slip: number, surf = S_ASPHALT, grounded = true) => ({ slip, surf, grounded });
const all = (slip: number) => [0, 1, 2, 3].map(() => wheel(slip));

describe('tyreNoise', () => {
  it('is silent with grip in hand, scrubs faintly as the peak nears, squeals from 90% of it and is full a little past', () => {
    expect(tyreNoise(all(0.5), 30)).toEqual({ squeal: 0, scrub: 0 });
    expect(tyreNoise(all(SQUEAL_SLIP[0]), 30)).toEqual({ squeal: 0, scrub: expect.closeTo(0.5, 6) });
    expect(tyreNoise(all(0.7), 30).scrub).toBeCloseTo(0.25, 6);
    expect(tyreNoise(all(1), 30).squeal).toBeCloseTo(0.4, 6);
    expect(tyreNoise(all(SQUEAL_SLIP[1]), 30)).toEqual({ squeal: 1, scrub: 1 });
    // one tyre over the edge is most of the sound; grass and gravel have their own; nothing at a standstill or airborne
    expect(tyreNoise([wheel(2), wheel(0), wheel(0), wheel(0)], 30).squeal).toBeCloseTo(0.65 + 0.35 / 4, 6);
    expect(tyreNoise([wheel(2, S_KERB), wheel(2, S_GRASS), wheel(2, S_ASPHALT, false), wheel(0)], 30).squeal).toBeCloseTo(0.65 + 0.35 / 4, 6);
    expect(tyreNoise(all(2), 0).squeal).toBe(0);
  });
});

// Holds `kmh` with the throttle, the road wheels turned 1 s in at `degPerS` up to `maxDeg`.
const holdSpeed = (c: Vehicle, kmh: number) => { const e = kmh - c.speedF * 3.6; return { throttle: Math.min(1, Math.max(0, 0.3 + 0.2 * e)), brake: e < -4 ? Math.min(1, -0.05 * e) : 0 }; };
const latG = (c: Vehicle) => Math.hypot(c.vel.x, c.vel.z) * Math.abs(c.angv.dot(c.up)) / 9.81;
const bodySlip = (c: Vehicle) => Math.atan2(c.vel.dot(c.left), Math.max(3, Math.abs(c.speedF))) * 180 / Math.PI;
async function rolling(id: CarId, kmh: number) {
  const s = await session(id, { walls: false });
  s.car.forceSurface = S_ASPHALT;
  s.car.placeAt(s.car.proj.s, 0, kmh / 3.6);
  return s;
}

const CASES: [CarId, kmh: number, degPerS: number, maxDeg: number][] = [['lcf1', 150, 0.4, 12], ['lcgt3', 150, 0.5, 14], ['drift', 80, 1.2, 16]];
describe.each(CASES)('%s', (id, kmh, degPerS, maxDeg) => {
  it(`is silent at 70% of its cornering limit at ${kmh} km/h and squeals at it and past it`, async () => {
    const { car, drive, session: s } = await rolling(id, kmh);
    const rows: { t: number; g: number; squeal: number; scrub: number }[] = [];
    let g = 0;
    const t0 = s.simTime;
    drive(maxDeg / degPerS + 1, (c, t): DriveInput =>
      ({ ...holdSpeed(c, kmh), steer: 0, analog: true, steerAngle: Math.max(0, t - t0 - 1) * degPerS * Math.PI / 180, autoGears: true }), () => {
      g += (latG(car) - g) * (1 - Math.exp(-(1 / 120) / 0.15));   // smoothed over 0.15 s
      rows.push({ t: s.simTime - t0, g, ...tyreNoise(car.wheels, Math.abs(car.speedF)) });
      return Math.abs(bodySlip(car)) > 8;
    });
    const max = rows.reduce((a, b) => (b.g > a.g ? b : a));
    const at = (share: number) => rows.find((r) => r.g >= share * max.g)!;
    const past = rows.filter((r) => r.t >= max.t && r.t <= max.t + 1);
    log(id, { maxG: max.g, at70: at(0.7), at90: at(0.9), atMax: max, past: past.at(-1) });
    expect(max.t).toBeLessThan(rows.at(-1)!.t - 1);           // the ramp went on past the limit
    expect(at(0.7)).toMatchObject({ squeal: 0, scrub: 0 });
    expect(at(0.9).squeal).toBe(0);
    expect(Math.max(...past.map((r) => r.squeal))).toBeGreaterThan(0.15);
    expect(max.squeal + max.scrub).toBeGreaterThan(0.4);      // at the limit: the scrub at least, the squeal coming in
  });

  it('under full ABS braking in a straight line squeals only if the tyres are past their peak', async () => {
    const { car, drive } = await rolling(id, id === 'drift' ? 140 : 250);
    const squeal: number[] = [], past: number[] = [], spec = CARS[id];
    // the front tyre's lateral over longitudinal peak slip (its braking force peaks at 1 / this of the lateral peak)
    const longMult = spec.physics === 'lc' ? createTyreRuntime(compoundData(spec.config, spec.config.compoundSlots.soft)).brush!.longStiffnessMult : 1;
    drive(10, () => ({ throttle: 0, brake: 1, steer: 0, analog: true, steerAngle: 0, autoGears: true }), () => {
      squeal.push(tyreNoise(car.wheels, Math.abs(car.speedF)).squeal);
      if (id !== 'drift') {
        // The engine's own account of the front tyres: slip ratio over the one where their braking force peaks
        const e = lc(car).vehicle.wheels[0], p = Math.tan(e.peakSlipAngleRad) / longMult;
        past.push(-e.slipRatio / (p / (1 + p)));
      }
      return car.speedF < 40 / 3.6;
    });
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    log(id, 'braking: squeal median', median(squeal), 'max', Math.max(...squeal), 'front slip ratio over its peak, median', past.length ? median(past) : '-');
    if (id === 'lcf1') {
      // The F1's ABS (LibreCorsa's semi_pro dial) holds its fronts at about twice their peak slip ratio: it squeals
      expect(median(past)).toBeGreaterThan(1.5);
      expect(median(squeal)).toBeGreaterThan(0.6);
    } else {
      // The GT3's holds them just under it (as the drift car's model of ABS does): quiet, at most a rare chirp
      if (id === 'lcgt3') expect(median(past)).toBeLessThan(1);
      expect(median(squeal)).toBeLessThan(0.05);
      expect(squeal.filter((x) => x > 0.2).length / squeal.length).toBeLessThan(0.1);   // GT3: 6%
    }
  });
});
