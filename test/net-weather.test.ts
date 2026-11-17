import { describe, expect, it } from 'vitest';
import {
  MAX_WEATHER_KEYS, MAX_WEATHER_T, resolveWeather, WEATHER_KINDS, WEATHER_STEP, type WeatherKey, weatherAt, weatherKeys,
} from '../src/net/weather';

// A session's weather (src/net/weather.ts): deterministic from the seed, within range, wetness following the rain,
// and the interpolation the clients use. NET_REPORT=1 prints a summary per kind.

const SEEDS = Array.from({ length: 60 }, (_, k) => (k * 2654435761) >>> 0);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('weather', () => {
  it('is the same from the same seed, and differs between seeds', () => {
    for (const kind of WEATHER_KINDS) {
      expect(weatherKeys(kind, 1234)).toEqual(weatherKeys(kind, 1234));
      // a window of keyframes is the same as that part of the whole
      if (resolveWeather(kind, 99) !== 'dry') expect(weatherKeys(kind, 99, 10, 5)).toEqual(weatherKeys(kind, 99, 0, 15).slice(10, 15));
    }
    expect(weatherKeys('changeable', 1)).not.toEqual(weatherKeys('changeable', 2));
    expect(new Set(SEEDS.map((s) => resolveWeather('random', s))).size).toBe(4);
    expect(resolveWeather('wet', 5)).toBe('wet');
  });

  it('stays in range, a minute apart, quantised as on the wire, for every kind', () => {
    for (const kind of WEATHER_KINDS) {
      for (const seed of SEEDS.slice(0, 20)) {
        const keys = weatherKeys(kind, seed);
        if (resolveWeather(kind, seed) === 'dry') {
          expect(keys).toEqual([{ t: 0, rain: 0, wet: 0 }, { t: MAX_WEATHER_T, rain: 0, wet: 0 }]);
          continue;
        }
        expect(keys.length).toBe(MAX_WEATHER_KEYS);
        keys.forEach((k, i) => {
          expect(k.t).toBe(i * WEATHER_STEP);
          for (const v of [k.rain, k.wet]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); expect(Math.abs(v * 255 - Math.round(v * 255))).toBeLessThan(1e-9); }
        });
        for (let i = 1; i < keys.length; i++) expect(Math.abs(keys[i].rain - keys[i - 1].rain)).toBeLessThanOrEqual(0.25 + 1 / 255);
      }
    }
    const end = weatherKeys('wet', 3, 2000, 64);   // past the wire's 18 hours: the last keyframe there
    expect(end.length).toBe(1);
    expect(end[0].t).toBeLessThanOrEqual(MAX_WEATHER_T);
  });

  it('gives each kind its character: damp drizzles, wet rains, changeable has both', () => {
    const per = (kind: 'damp' | 'wet' | 'changeable') => {
      const keys = SEEDS.flatMap((s) => weatherKeys(kind, s));
      return { rain: mean(keys.map((k) => k.rain)), wet: mean(keys.map((k) => k.wet)), dryShare: mean(keys.map((k) => (k.rain === 0 ? 1 : 0))),
        maxRain: Math.max(...keys.map((k) => k.rain)) };
    };
    const damp = per('damp'), wet = per('wet'), ch = per('changeable');
    if (process.env.NET_REPORT) console.log({ damp, wet, changeable: ch });
    expect(damp.maxRain).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(damp.wet).toBeGreaterThan(0.1); expect(damp.wet).toBeLessThan(0.6);
    expect(wet.rain).toBeGreaterThan(0.35);
    expect(wet.wet).toBeGreaterThan(0.75);
    expect(ch.dryShare).toBeGreaterThan(0.3); expect(ch.dryShare).toBeLessThan(0.8);
    expect(ch.maxRain).toBeGreaterThan(0.6);
  });

  it('wets the track under rain and dries it slowly after', () => {
    let showers = 0, dryings = 0;
    for (const seed of SEEDS) {
      const k = weatherKeys('changeable', seed);
      for (let i = 1; i + 3 < k.length; i++) {
        // two minutes of real rain: the track is no drier at the end (wetter unless soaked already)
        if (k[i].rain >= 0.4 && k[i + 1].rain >= 0.4 && k[i + 2].rain >= 0.4) {
          showers++;
          expect(k[i + 2].wet).toBeGreaterThanOrEqual(k[i].wet - 1 / 255);
          if (k[i].wet < 0.5) expect(k[i + 2].wet).toBeGreaterThan(k[i].wet + 0.1);
        }
        // no rain: it dries, by at most 7% of its wetness a minute (a quarter of an hour's time constant)
        if (k[i - 1].rain === 0 && k[i].rain === 0) {
          dryings++;
          expect(k[i].wet).toBeLessThanOrEqual(k[i - 1].wet + 1e-9);
          expect(k[i - 1].wet - k[i].wet).toBeLessThanOrEqual(0.07 * k[i - 1].wet + 2 / 255);
        }
      }
    }
    expect(showers).toBeGreaterThan(20);
    expect(dryings).toBeGreaterThan(100);
  });

  it('interpolates linearly between keyframes and holds the ends', () => {
    const keys: WeatherKey[] = [{ t: 0, rain: 0, wet: 0.2 }, { t: 60, rain: 1, wet: 0.4 }, { t: 120, rain: 0.5, wet: 1 }];
    expect(weatherAt(keys, -5)).toEqual({ rain: 0, wet: 0.2 });
    expect(weatherAt(keys, 30).rain).toBeCloseTo(0.5, 12);
    expect(weatherAt(keys, 30).wet).toBeCloseTo(0.3, 12);
    expect(weatherAt(keys, 90)).toEqual({ rain: 0.75, wet: 0.7 });
    expect(weatherAt(keys, 500)).toEqual({ rain: 0.5, wet: 1 });
    expect(weatherAt([], 10)).toEqual({ rain: 0, wet: 0 });
    const out = { rain: 9, wet: 9 };
    expect(weatherAt(keys, 60, out)).toBe(out);
    expect(out).toEqual({ rain: 1, wet: 0.4 });
  });
});
