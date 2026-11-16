// The HUD's tyre widget: its colour bands, and which cars have tyre telemetry at all (the LC cars' numbers are
// tested in lc-car.ts).
import { describe, expect, it } from 'vitest';
import { treadBand, tyreBand } from '../src/tyreHud';
import { session } from './harness';

describe('tyreBand', () => {
  it('places a temperature against the working window', () => {
    const W = [95, 110] as const;
    expect([60, 84.9, 85, 94.9, 95, 102, 110, 110.1, 120, 120.1, 300].map((c) => tyreBand(c, W)))
      .toEqual(['cold', 'cold', 'cool', 'cool', 'ok', 'ok', 'ok', 'warm', 'warm', 'hot', 'hot']);
    expect(tyreBand(60, [70, 85])).toBe('cool');   // the GT3 out of its blankets, 10 deg short
    expect(tyreBand(80, [95, 110])).toBe('cold');  // the F1 out of its blankets, 15 deg short
  });
  it('places the tread surface against the same window with twice the margin (a quarter of the grip, and it swings)', () => {
    const W = [95, 110] as const;
    expect([60, 74.9, 75, 94.9, 95, 110, 110.1, 130, 130.1].map((c) => treadBand(c, W)))
      .toEqual(['cold', 'cold', 'cool', 'cool', 'ok', 'ok', 'warm', 'warm', 'hot']);
  });
});

describe('tyre telemetry', () => {
  it('is reported by the cars on LibreCorsa\'s engine and not by the drift car (no tyre heat in our physics)', async () => {
    for (const id of ['lcf1', 'lcgt3'] as const) expect((await session(id)).car.tyres?.wheels).toHaveLength(4);
    expect((await session('drift')).car.tyres).toBeUndefined();
  });
});
