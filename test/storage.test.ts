// Saved settings and best times: corrupt or old data must load as defaults, not break the game.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/settings';
import { loadStore } from '../src/timing';

afterEach(() => localStorage.clear());

describe('loadSettings', () => {
  it('ignores corrupt or non-object data', () => {
    for (const raw of ['{not json', '"garbage"', '42', 'null', '[1,2]']) {
      localStorage.setItem('fastroads.settings', raw);
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });
  it('keeps valid choices and drops unknown keys and values', () => {
    localStorage.setItem('fastroads.settings', JSON.stringify({ car: 'drift', camera: 'nope', extra: 1 }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, car: 'drift' });
  });
  it('replaces a removed car with its LibreCorsa-engine twin', () => {
    for (const [old, now] of [['f1', 'lcf1'], ['gt3', 'lcgt3']]) {
      localStorage.setItem('fastroads.settings', JSON.stringify({ car: old }));
      expect(loadSettings().car).toBe(now);
    }
  });
});

describe('loadStore', () => {
  const key = 'test.store';
  const empty = { bestLap: null, bestSectors: [null, null, null], bestTrace: null, bestLapSectors: null };
  it('rejects corrupt or wrong-shaped data', () => {
    for (const raw of ['{not json', '"x"', '{"bestSectors":[1,"x"]}', '{"bestSectors":[1,2,3],"bestLap":"fast"}', '{"bestSectors":[null,null,null],"bestTrace":7}']) {
      localStorage.setItem(key, raw);
      expect(loadStore(key)).toEqual(empty);
    }
  });
  it('loads a valid store, filling fields older versions lacked', () => {
    localStorage.setItem(key, JSON.stringify({ bestLap: 90.5, bestSectors: [30, 30, 30.5], bestTrace: [0, 1.2, null] }));
    expect(loadStore(key)).toEqual({ bestLap: 90.5, bestSectors: [30, 30, 30.5], bestTrace: [0, 1.2, null], bestLapSectors: null });
  });
});
