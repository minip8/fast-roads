// The GT3's synthesised engine loops (src/engineLoops.ts): seamless, bounded, and with the spectrum of a cross-plane
// V8: the firing order strongest, half orders of the crank present, weight under the firing note and little buzz
// above it, brighter on load than on the overrun.
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { engineLoop, LOOP_RMS, loopCount, makeLoop, type EngineLoop } from '../src/engineLoops';

const SR = 48000;
const voice = CARS.lcgt3.sound.loops!;
const loops = Array.from({ length: loopCount(voice) }, (_, k) => makeLoop(voice, SR, k));

// Amplitude of crank order `order`: the loop holds a whole number of engine cycles (two crank turns), so every
// half order falls exactly on a DFT bin.
function orderAmp(l: EngineLoop, order: number) {
  const x = l.data, w = 2 * Math.PI * Math.round(l.cycles * 2 * order) / x.length;
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
  return Math.hypot(re, im) * 2 / x.length;
}
const db = (a: number, b: number) => 20 * Math.log10(a / b);
// Amplitude-weighted mean frequency of the half-order lines up to 8 kHz.
function centroid(l: EngineLoop) {
  const f0 = l.rpm / 120; let num = 0, den = 0;
  for (let h = 1; h * f0 < 8000; h++) { const a = orderAmp(l, h / 2); num += a * h * f0; den += a; }
  return num / den;
}

describe('GT3 engine loops', () => {
  it('has an on-load and an overrun loop per rpm point, in phase with each other', () => {
    expect(loops).toHaveLength(voice.rpms.length * 2);
    voice.rpms.forEach((rpm, p) => {
      const on = loops[2 * p], off = loops[2 * p + 1];
      expect(on.rpm).toBe(off.rpm);
      expect(on.data.length).toBe(off.data.length);
      expect(Math.abs(on.rpm - rpm)).toBeLessThan(rpm * 0.005);
      expect(on.data.length).toBe(Math.round(SR * 120 / on.rpm) * on.cycles);   // whole engine cycles
    });
  });

  it('is bounded, at the common level, and the same every time', () => {
    for (const l of loops) {
      let peak = 0, ss = 0;
      for (const s of l.data) { expect(Number.isFinite(s)).toBe(true); peak = Math.max(peak, Math.abs(s)); ss += s * s; }
      expect(peak).toBeLessThanOrEqual(0.981);
      expect(Math.sqrt(ss / l.data.length)).toBeGreaterThan(LOOP_RMS * 0.9);
      expect(Math.sqrt(ss / l.data.length)).toBeLessThan(LOOP_RMS * 1.01);
    }
    expect(engineLoop(voice, SR, 4000, 1, 3).data).toEqual(engineLoop(voice, SR, 4000, 1, 3).data);
  });

  // Each loop is a whole number of engine cycles, so its seam falls on a cycle start: the step across it must be
  // like the step at the other cycle starts (a firing may begin there), not a jump.
  it('loops without a click: the seam is like any other cycle start', () => {
    for (const l of loops) {
      const x = l.data, n = x.length, cycle = n / l.cycles;
      const d2 = (i: number) => Math.abs(x[(i + 1 + n) % n] - 2 * x[(i + n) % n] + x[(i + n - 1) % n]);
      const step = (i: number) => Math.max(d2(i), d2(i - 1));
      const others = Array.from({ length: l.cycles - 1 }, (_, c) => step((c + 1) * cycle));
      expect(step(0)).toBeLessThan(1.5 * Math.max(...others));
    }
  });

  it('has the firing order strongest and the cross-plane half orders', () => {
    for (const l of loops) {
      const fire = orderAmp(l, 4);
      for (const o of [0.5, 1, 2, 3, 3.5, 5, 6]) expect(db(orderAmp(l, o), fire)).toBeLessThan(-6);
      // each bank fires unevenly: 1.5 and 2.5 come through from the side exits
      expect(db(Math.max(orderAmp(l, 1.5), orderAmp(l, 2.5)), fire)).toBeGreaterThan(-25);
    }
  });

  // Share of the loop's power in the half orders under the firing order (the rumble), above four times it (the
  // buzz), and from 1 to 4 kHz. Before the loops were deepened: 8-27% under from 2,800 rpm, up to 25% buzz and 38%
  // from 1 to 4 kHz on load. At 2,000 rpm the firing note itself (133 Hz) is the low end.
  function shares(l: EngineLoop) {
    const f0 = l.rpm / 120; let all = 0, under = 0, buzz = 0, mid = 0;
    for (let h = 1; h * f0 < 12000; h++) {
      const e = orderAmp(l, h / 2) ** 2, f = h * f0;
      all += e; if (h < 8) under += e; if (h > 32) buzz += e; if (f >= 1000 && f < 4000) mid += e;
    }
    return { under: under / all, buzz: buzz / all, mid: mid / all };
  }
  it('has weight under the firing note and little buzz above it, rounder still on the overrun', () => {
    voice.rpms.forEach((rpm, p) => {
      const on = shares(loops[2 * p]), off = shares(loops[2 * p + 1]);
      if (rpm > 2500) { expect(on.under).toBeGreaterThan(0.25); expect(off.under).toBeGreaterThan(0.3); }
      expect(on.buzz).toBeLessThan(0.06); expect(on.mid).toBeLessThan(0.2);
      expect(off.buzz).toBeLessThan(on.buzz / 3); expect(off.mid).toBeLessThan(on.mid / 3);
    });
  });

  it('is brighter on load than on the overrun', () => {
    for (let p = 0; p < voice.rpms.length; p++) expect(centroid(loops[2 * p])).toBeGreaterThan(1.5 * centroid(loops[2 * p + 1]));
  });
});
