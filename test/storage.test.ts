// Saved settings and best times: corrupt or old data must load as defaults, not break the game.
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIONS, bindKey, DEFAULT_BINDINGS, keyLabel, loadBindings, saveBindings } from '../src/keys';
import { DEFAULT_SETTINGS, loadSettings, nextOption, SETTING_DEFS, SETTING_KEYS } from '../src/settings';
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
  it('loads settings saved before the newer settings existed, giving those their defaults', () => {
    const old = { track: 'silverstone', car: 'drift', gearbox: 'manual', steering: 'mouse', mouseSens: 'low', mouseDeadzone: 'off',
      camera: 'chase', hands: 'on', tc: 'off', assist: 'on', sound: 'off' };
    localStorage.setItem('fastroads.settings', JSON.stringify(old));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, ...old });
  });
  it('accepts only listed slider values', () => {
    localStorage.setItem('fastroads.settings', JSON.stringify({ fov: 10, volume: 55, hudScale: '120', resolution: 50 }));
    const s = loadSettings();
    expect([s.fov, s.volume, s.hudScale, s.resolution]).toEqual([10, DEFAULT_SETTINGS.volume, DEFAULT_SETTINGS.hudScale, 50]);
  });
  it('replaces a removed car with its LibreCorsa-engine twin', () => {
    for (const [old, now] of [['f1', 'lcf1'], ['gt3', 'lcgt3']]) {
      localStorage.setItem('fastroads.settings', JSON.stringify({ car: old }));
      expect(loadSettings().car).toBe(now);
    }
  });
});

describe('settings definitions', () => {
  it('give every setting a default among its options', () => {
    for (const k of SETTING_KEYS) expect(SETTING_DEFS[k].options.map(([v]) => v)).toContain(DEFAULT_SETTINGS[k]);
  });
  it('name only real actions in their hints', () => {
    for (const k of SETTING_KEYS) for (const [, a] of (SETTING_DEFS[k].hint ?? '').matchAll(/\{(\w+)\}/g)) expect(Object.keys(ACTIONS)).toContain(a);
  });
  it('step sliders to their ends and wrap the others round', () => {
    expect(nextOption('volume', 100, 1)).toBe(100);
    expect(nextOption('volume', 0, -1)).toBe(0);
    expect(nextOption('volume', 50, 1)).toBe(60);
    expect(nextOption('units', 'mph', 1)).toBe('kmh');
    expect(nextOption('camera', 'onboard', -1)).toBe('far');
  });
});

describe('key bindings', () => {
  it('load as defaults from nothing or corrupt data', () => {
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
    for (const raw of ['{not json', '"x"', '42', 'null']) {
      localStorage.setItem('fastroads.keys', raw);
      expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
    }
  });
  it('keep valid saved actions, drop invalid ones and a key bound twice', () => {
    localStorage.setItem('fastroads.keys', JSON.stringify({ throttle: ['KeyI', null], brake: ['KeyK', 7], camera: ['KeyI', 'Escape'], left: 'KeyJ' }));
    const b = loadBindings();
    expect(b.throttle).toEqual(['KeyI', null]);
    expect(b.brake).toEqual(DEFAULT_BINDINGS.brake);    // 7 is not a key
    expect(b.camera).toEqual(DEFAULT_BINDINGS.camera);  // Esc can't be bound
    expect(b.left).toEqual(DEFAULT_BINDINGS.left);
  });
  it('move a key to its new action, and never bind Esc', () => {
    let b = bindKey(DEFAULT_BINDINGS, 'camera', 1, 'KeyW');
    expect(b.camera).toEqual(['KeyC', 'KeyW']);
    expect(b.throttle).toEqual([null, 'ArrowUp']);
    b = bindKey(b, 'camera', 0, null);
    expect(b.camera).toEqual([null, 'KeyW']);
    expect(bindKey(b, 'help', 0, 'Escape')).toEqual(b);
    saveBindings(b);
    expect(loadBindings()).toEqual(b);
    expect(DEFAULT_BINDINGS.throttle).toEqual(['KeyW', 'ArrowUp']);   // the defaults are never changed in place
  });
  it('give an action added since the save its default key, unless the save already uses that key', () => {
    expect(DEFAULT_BINDINGS.lookBack).toEqual(['KeyB', null]);
    const old = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).filter(([a]) => a !== 'lookBack'));
    localStorage.setItem('fastroads.keys', JSON.stringify(old));
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
    localStorage.setItem('fastroads.keys', JSON.stringify({ ...old, help: ['KeyB', null] }));
    const b = loadBindings();
    expect(b.help).toEqual(['KeyB', null]);
    expect(b.lookBack).toEqual([null, null]);
    expect(bindKey(b, 'lookBack', 1, 'ShiftLeft').lookBack).toEqual([null, 'ShiftLeft']);   // rebindable as any other
  });
  it('label keys briefly', () => {
    expect(['KeyW', 'Digit3', 'ArrowLeft', 'Numpad8', 'ShiftLeft', 'Space', 'F5'].map(keyLabel)).toEqual(['W', '3', '←', 'Num 8', 'L Shift', 'Space', 'F5']);
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
