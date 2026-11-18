// The oscillator engine voices (src/audioGraph.ts), computed from the wave and the filters the graph puts it
// through (Web Audio's biquads, as specified): at full throttle weight under the firing note and no buzz on top; off
// the throttle and at idle, still plainly there.
import { describe, expect, it } from 'vitest';
import { cycleHarmonics, engineCutoff, engineGain, engineLoad, type EngineVoice } from '../src/audioGraph';
import { CARS, type CarId } from '../src/cars';
import { aWeight } from './aWeight';

const SR = 48000;

// |H(f)| of a Web Audio BiquadFilterNode (the Audio EQ Cookbook formulas the spec uses).
function biquad(type: 'lowpass' | 'highpass' | 'peaking' | 'lowshelf', f0: number, q: number, db: number) {
  const A = 10 ** (db / 40), w0 = 2 * Math.PI * f0 / SR, c = Math.cos(w0), s = Math.sin(w0);
  let b: number[], a: number[];
  if (type === 'lowpass' || type === 'highpass') {
    const al = s / (2 * 10 ** (q / 20)), k = type === 'lowpass' ? 1 - c : 1 + c, sg = type === 'lowpass' ? 1 : -1;   // Q in dB here
    b = [k / 2, sg * k, k / 2]; a = [1 + al, -2 * c, 1 - al];
  } else if (type === 'peaking') {
    const al = s / (2 * q);
    b = [1 + al * A, -2 * c, 1 - al * A]; a = [1 + al / A, -2 * c, 1 - al / A];
  } else {
    const al = s / 2 * Math.SQRT2, r = 2 * Math.sqrt(A) * al;   // shelf slope 1
    b = [A * ((A + 1) - (A - 1) * c + r), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - r)];
    a = [(A + 1) + (A - 1) * c + r, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - r];
  }
  return (f: number) => {
    const w = 2 * Math.PI * f / SR;
    const h = (p: number[]) => Math.hypot(p[0] + p[1] * Math.cos(w) + p[2] * Math.cos(2 * w), p[1] * Math.sin(w) + p[2] * Math.sin(2 * w));
    return h(b) / h(a);
  };
}

// Power of each line the engine plays at `rpm` and `load` (1: full throttle), before the engine's gain: [Hz, power][].
function lines(v: EngineVoice, rpm: number, load = 1) {
  const f0 = rpm / 120;
  const chain = [
    biquad('highpass', 30, 0.7, 0), biquad('lowpass', engineCutoff(v, rpm, load), 0.8, 0),
    biquad('peaking', v.body[0], v.body[1], v.body[2] + (v.body[3] - v.body[2]) * load), biquad('lowshelf', v.weight[0], 0, v.weight[1]),
  ];
  return Array.from(cycleHarmonics(v), (a, k) => [k * f0, a] as const)
    .filter(([f, a]) => a > 0 && f < SR / 2)
    .map(([f, a]) => [f, (a * chain.reduce((g, h) => g * h(f), 1)) ** 2] as const);
}
const share = (ls: (readonly [number, number])[], keep: (f: number) => boolean) =>
  ls.reduce((s, [f, p]) => s + (keep(f) ? p : 0), 0) / ls.reduce((s, [, p]) => s + p, 0);

const VOICES: [CarId, number[]][] = [['lcf1', [6000, 9000, 12000]], ['drift', [2500, 4500, 7000]], ['lcgt3', [2500, 4500, 7000]]];

describe('oscillator engine voices', () => {
  it('put every harmonic and order on the wave', () => {
    for (const [id] of VOICES) {
      const v = CARS[id].sound;
      expect(Number.isInteger(60 / v.firingDiv)).toBe(true);
      const amps = cycleHarmonics(v);
      for (const [order] of v.orders) { expect(Number.isInteger(order * 2)).toBe(true); expect(order * 2).toBeLessThan(amps.length); }
    }
  });

  // Share of the power under the firing note (half and crank orders: the weight) and above four times it (the buzz).
  // Before the voices were deepened: F1 under 1%, buzz 2-6%; drift car 11-31% and 1%; GT3 7-15% and 1-2%.
  const shares = (id: CarId) => VOICES.find(([c]) => c === id)![1].map((rpm) => {
    const v = CARS[id].sound, fire = rpm / v.firingDiv, ls = lines(v, rpm);
    return { under: share(ls, (f) => f < fire * 0.99), buzz: share(ls, (f) => f > fire * 4.01) };
  });
  const BOUNDS: Record<CarId, [under: number, buzz: number]> = { lcf1: [0.07, 0.01], drift: [0.18, 0.005], lcgt3: [0.35, 0.005] };
  it.each(VOICES)('%s has weight under the firing note and little buzz', (id) => {
    for (const s of shares(id)) { expect(s.under).toBeGreaterThan(BOUNDS[id][0]); expect(s.buzz).toBeLessThan(BOUNDS[id][1]); }
  });

  // The F1 keeps its high, smooth note (it is not a V8); the GT3's (heard while its loops are made) is the deepest.
  it('keeps each car its character', () => {
    const [f1, drift, gt3] = (['lcf1', 'drift', 'lcgt3'] as const).map((id) => shares(id));
    f1.forEach((s, k) => { expect(s.under).toBeLessThan(0.25); expect(s.under).toBeLessThan(drift[k].under); });
    drift.forEach((s, k) => expect(s.under).toBeLessThan(gt3[k].under));
  });
});

// The engine's A-weighted level (dB, relative) as the graph plays it: the voice's lines through the chain at the load
// the graph plays (engineLoad), times its gain (engineGain).
function heard(id: CarId, rpm: number, throttle: number) {
  const spec = CARS[id], v = spec.sound, load = engineLoad(throttle, rpm, spec.idle);
  const p = lines(v, rpm, load).reduce((s, [f, pw]) => s + pw * aWeight(f) ** 2, 0);
  return 10 * Math.log10(p) + 20 * Math.log10(engineGain(v, load, rpm / spec.redline));
}

describe('engine off the throttle', () => {
  // The owner: "there should be sound even if the car is not on throttle". Off the throttle the engine is quieter and
  // duller, as a real one on the overrun, but plainly there: 4-10 dB under full throttle at the same rpm (now 7-8 dB
  // for the F1 and the drift car, 5-6 for the GT3's stand-in voice; before, its gain fell to 0.4 of full and its
  // filter closed further, 9-12 dB down in a render, under the wind at speed), and a lift is still heard as one. The
  // GT3's own loops are checked the same way in engineLoops.test.ts.
  it.each(VOICES)('%s stays audible on the overrun', (id, rpms) => {
    for (const rpm of rpms) {
      const drop = heard(id, rpm, 1) - heard(id, rpm, 0);
      expect(drop).toBeGreaterThan(4);
      expect(drop).toBeLessThan(10);
    }
  });

  // At idle the engine is running, not on the overrun (engineLoad's idle share): heard within 20 dB of full throttle
  // high in the rev range (now the F1 10 dB under it, the drift car 19; in a render before: 17 and 26 dB).
  it.each(VOICES)('%s is heard idling', (id, rpms) => {
    const spec = CARS[id];
    expect(engineLoad(0, spec.idle, spec.idle)).toBeGreaterThan(0.3);
    expect(engineLoad(0, spec.idle * 1.5, spec.idle)).toBe(0);
    expect(heard(id, rpms[rpms.length - 1], 1) - heard(id, spec.idle, 0)).toBeLessThan(20);
  });

  // The throttle opens and closes the sound smoothly: the level rises with the throttle, a step of 0.1 at most 2 dB.
  it.each(VOICES)('%s follows the throttle without jumps', (id, rpms) => {
    for (const rpm of rpms) {
      let prev = heard(id, rpm, 0);
      for (let k = 1; k <= 10; k++) {
        const db = heard(id, rpm, k / 10);
        expect(db).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(db - prev).toBeLessThan(2);
        prev = db;
      }
    }
  });
});
