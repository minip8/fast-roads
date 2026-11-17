import { describe, expect, it } from 'vitest';
import {
  boardRows, closedText, closestPreset, DEFAULT_PRESET, FIELD_GROUPS, joinErrorText, newRoomSettings, nextSession, optionLabel, presetOf, PRESETS,
  presetSummary, raceRows, ROOM_FIELDS, RoomLog, sessionState, sessionTitle, stepOption, tyreLaps, tyreLifeShort, weekendFacts, weekendSummary,
  withCircuit, withPreset,
} from '../src/lobby';
import {
  defaultSettings, ERROR, normaliseSettings, type NetClient, type NetEvent, type RoomSettings, SETTING_RANGES, type SessionInfo,
  TYRE_WEAR,
} from '../src/net';
import { decodeMessage, encodeMessage } from '../src/net/protocol';
import { TRACKS, type TrackId } from '../src/tracks';
import { lobbySession } from '../src/net/race';
import { CODE_ALPHABET, CODE_LENGTH, clearSeat, inviteUrl, loadSeat, newRoomCode, parseInvite, saveSeat, validRoom } from '../src/netPrefs';

// The menu's side of multiplayer without a browser: room codes, invite links, the tab's seat, the weekend settings
// as menu controls, presets, the session in words, results tables, and what the menu keeps between events.

describe('room codes', () => {
  it('are valid, of the unambiguous alphabet, and spread over it', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const seen = new Set<string>(), chars = new Set<string>();
    for (let k = 0; k < 2000; k++) {
      const c = newRoomCode(rand);
      expect(c).toHaveLength(CODE_LENGTH);
      expect(validRoom(c)).toBe(true);
      for (const ch of c) chars.add(ch);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1990);
    expect([...chars].sort().join('')).toBe([...CODE_ALPHABET].sort().join(''));
    for (const bad of '0O1IL2Z5S8BUVQ') expect(CODE_ALPHABET).not.toContain(bad);
    expect(newRoomCode(() => 0.999999999)).toBe(CODE_ALPHABET.at(-1)!.repeat(CODE_LENGTH));
  });
});

describe('the Join field', () => {
  it('takes a code in any case, with spaces or dashes', () => {
    expect(parseInvite('k7qx')).toEqual({ room: 'K7QX', server: '' });
    expect(parseInvite('  K7 - QX ')).toEqual({ room: 'K7QX', server: '' });
    expect(parseInvite('AB12CD34')).toEqual({ room: 'AB12CD34', server: '' });
  });
  it('takes a whole invite link, with the relay if it names one', () => {
    expect(parseInvite('https://example.com/game/?room=k7qx')).toEqual({ room: 'K7QX', server: '' });
    expect(parseInvite('http://localhost:5173/?autopilot&room=AB&server=ws://10.0.0.2:8787')).toEqual({ room: 'AB', server: 'ws://10.0.0.2:8787' });
    expect(parseInvite('example.com/?room=XY')).toEqual({ room: 'XY', server: '' });
    expect(parseInvite('https://example.com/?ROOM=xy&server=http://nope')).toEqual({ room: 'XY', server: '' });
  });
  it('refuses anything else', () => {
    for (const bad of ['', '   ', 'TOOLONGCODE', 'AB_C', 'é', 'https://example.com/', 'https://example.com/?room=', 'https://x/?room=A%20B!']) expect(parseInvite(bad)).toBeNull();
  });
  it('makes clean invite links', () => {
    expect(inviteUrl('K7QX', '', 'https://example.com/fr/?autopilot&room=OLD#x')).toBe('https://example.com/fr/?room=K7QX');
    expect(inviteUrl('K7QX', 'ws://10.0.0.2:8787', 'https://example.com/')).toBe('https://example.com/?room=K7QX&server=ws%3A%2F%2F10.0.0.2%3A8787');
    expect(parseInvite(inviteUrl('K7QX', 'ws://10.0.0.2:8787', 'https://example.com/'))).toEqual({ room: 'K7QX', server: 'ws://10.0.0.2:8787' });
  });
});

describe('the seat (rejoin token)', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m }; };
  it('is kept for its room and relay only', () => {
    const s = store();
    saveSeat({ room: 'K7QX', server: 'ws://a', token: 123456789 }, s);
    expect(loadSeat('K7QX', 'ws://a', s)).toBe(123456789);
    expect(loadSeat('K7QX', 'ws://b', s)).toBeNull();
    expect(loadSeat('OTHER', 'ws://a', s)).toBeNull();
    clearSeat(s);
    expect(loadSeat('K7QX', 'ws://a', s)).toBeNull();
  });
  it('ignores corrupt data and refuses bad seats', () => {
    const s = store();
    for (const v of ['{', 'null', '7', '{"room":"K7QX","server":"ws://a","token":0}', '{"room":"K7QX","server":"ws://a","token":1.5}', '{"room":"K7QX","server":"ws://a","token":"9"}', '{"room":"K7QX","server":"ws://a","token":4294967296}']) {
      s.m.set('fastroads.seat', v);
      expect(loadSeat('K7QX', 'ws://a', s)).toBeNull();
    }
    saveSeat({ room: 'bad code', server: 'ws://a', token: 5 }, s);
    saveSeat({ room: 'K7QX', server: 'ws://a', token: 0 }, s);
    expect(s.m.get('fastroads.seat')).toBe('{"room":"K7QX","server":"ws://a","token":4294967296}');
    expect(loadSeat('K7QX', 'ws://a', null)).toBeNull();   // no storage at all
  });
});

describe('the weekend settings as menu controls', () => {
  const s0 = defaultSettings('melbourne');
  it('cover every setting but the circuit, in a known group', () => {
    const keys = ROOM_FIELDS.map((f) => f.key).sort();
    expect(keys).toEqual((Object.keys(s0) as (keyof RoomSettings)[]).filter((k) => k !== 'circuit').sort());
    for (const f of ROOM_FIELDS) {
      expect(FIELD_GROUPS.map(([g]) => g)).toContain(f.group);
      expect(f.label.length).toBeGreaterThan(0); expect(f.hint.length).toBeGreaterThan(10);
    }
  });
  it('offer only values the relay keeps as they are (normaliseSettings), the defaults among them', () => {
    for (const f of ROOM_FIELDS) {
      expect(f.options.length).toBeGreaterThan(1);
      expect(f.options.map(([v]) => v)).toContain(s0[f.key]);
      for (const [v] of f.options) {
        const s = { ...s0, qualifying: 'timed' as const, [f.key]: v };
        expect(normaliseSettings(s)[f.key]).toBe(v);
      }
      if (f.key in SETTING_RANGES) {   // steppers reach both ends of the range
        const [lo, hi] = SETTING_RANGES[f.key as keyof typeof SETTING_RANGES];
        expect(f.options[0][0]).toBe(lo); expect(f.options.at(-1)![0]).toBe(hi);
      }
    }
  });
  it('step within their options, skipping what is not allowed', () => {
    const laps = ROOM_FIELDS.find((f) => f.key === 'raceLaps')!, grid = ROOM_FIELDS.find((f) => f.key === 'grid')!;
    expect(stepOption(laps, 5, 1, s0)).toBe(6);
    expect(stepOption(laps, 99, 1, s0)).toBe(99);
    expect(stepOption(laps, 1, -1, s0)).toBe(1);
    expect(stepOption(laps, 11, 1, s0)).toBe(12);     // between options: the next one that way
    expect(stepOption(laps, 11, -1, s0)).toBe(10);
    expect(optionLabel(laps, 11)).toBe('11 laps');
    const noQ = { ...s0, qualifying: 'none' as const, grid: 'random' as const };
    expect(stepOption(grid, 'random', 1, noQ, true)).toBe('joinOrder');
    expect(stepOption(grid, 'joinOrder', 1, noQ, true)).toBe('random');   // round, past qualifying and reversed
    expect(grid.allowed!('reversed', noQ)).toBe(false);
  });
});

describe('presets', () => {
  const CIRCUITS = Object.keys(TRACKS) as TrackId[];
  const KEYS = (Object.keys(defaultSettings('melbourne')) as (keyof RoomSettings)[]).filter((k) => k !== 'circuit' && k !== 'car');
  it('set every option but the circuit and the car, and survive the relay (normaliseSettings and the wire) at every circuit', () => {
    for (const p of PRESETS) {
      expect([...Object.keys(p.settings), 'tyreWear'].sort()).toEqual([...KEYS].sort());
      for (const id of CIRCUITS) {
        const s = withPreset({ ...defaultSettings(id), car: 'lcgt3' }, p);
        expect(normaliseSettings(s)).toEqual(s);
        expect(s.circuit).toBe(id);
        expect(s.car).toBe('lcgt3');
        expect(presetOf(s)).toBe(p);
        const m = decodeMessage(encodeMessage({ type: 'settings', settings: s }));
        expect(m.ok && m.msg.type === 'settings' && m.msg.settings).toEqual(s);
      }
    }
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
    for (const p of PRESETS) expect(p.blurb.length).toBeLessThan(70);
  });
  it('wear the tyres so the race wants the stops they make every car stop, at every circuit', () => {
    // (life of the race tyre as a share of the race: README's numbers through a stint model, lobby.ts presets)
    const bounds: Record<number, [number, number]> = { 0: [1.15, 1.75], 1: [0.5, 0.85], 2: [0.35, 0.6] };
    for (const p of PRESETS) for (const id of CIRCUITS) for (const car of ['lcf1', 'lcgt3', 'drift']) {
      const s = withPreset({ ...defaultSettings(id), car }, p), N = s.raceLaps, k = s.pitStops;
      const [lo, hi] = bounds[k];
      const slick = tyreLaps(p.tyre, s.tyreWear, id);
      expect(slick / N, `${p.id} at ${id}`).toBeGreaterThanOrEqual(lo);
      expect(slick / N, `${p.id} at ${id}`).toBeLessThanOrEqual(hi);
      const one = tyreLaps('allweather', s.tyreWear, id);   // the drift car's one tyre: enough sets for the stops, not fewer
      expect(one * (k + 1)).toBeGreaterThan(N);
      if (k > 0) expect(one).toBeLessThan(N * 1.25);   // and they do not last the race
      if (car === 'drift') expect(tyreLifeShort(s)).toMatch(/^Tyres ~/);
    }
    // a sprint has no stop and tyres that just last; a Grand Prix one stop, an endurance race two
    expect(PRESETS.map((p) => [p.id, p.settings.raceLaps, p.settings.pitStops])).toEqual(
      [['quick', 5, 0], ['sprint', 8, 0], ['gp', 15, 1], ['endurance', 25, 2], ['wet', 10, 0]]);
    expect(tyreLaps('soft', 1, 'melbourne')).toBeCloseTo(43, 6);
  });
  it('say in a line what they set here', () => {
    const s = defaultSettings('melbourne');
    expect(PRESETS.map((p) => presetSummary(p, s))).toEqual([
      'random grid · 5 laps · no stops · softs ~7 laps · dry',
      'one-shot qualifying · 8 laps · no stops · softs ~11 laps · dry',
      '10 min practice · 10 min qualifying · 15 laps · 1 stop · softs ~10 laps · dry',
      '15 min practice · 15 min qualifying · 25 laps · 2 stops · softs ~11 laps · dry',
      '10 min practice · 10 min qualifying · 10 laps · no stops · wets ~14 laps · wet',
    ]);
    expect(presetSummary(PRESETS[2], { ...s, car: 'drift' })).toContain('tyres ~13 laps');
  });
  it('make a new room: the default format, everyone in the host car', () => {
    const s = newRoomSettings(defaultSettings('monza'), 'lcgt3');
    expect(s.car).toBe('lcgt3');
    expect(presetOf(s)).toBe(DEFAULT_PRESET);
    expect(normaliseSettings(s)).toEqual(s);
    expect(ROOM_FIELDS.find((f) => f.key === 'car')!.options.map(([v]) => v)).toEqual(['lcf1', 'lcgt3', 'drift', '']);
    for (const p of PRESETS) expect(withPreset(s, p).car).toBe('lcgt3');   // a format keeps the car
  });
  it('know when they were changed, and follow the room to another circuit', () => {
    const gp = PRESETS.find((p) => p.id === 'gp')!, s = withPreset(defaultSettings('melbourne'), gp);
    const custom = { ...s, raceLaps: 20 };
    expect(presetOf(custom)).toBeNull();
    expect(closestPreset(custom)).toBe(gp);
    expect(weekendFacts(custom)[0]).toEqual(['Format', 'Custom (based on Grand Prix)']);
    const monaco = withCircuit(s, 'monaco');
    expect(presetOf(monaco)).toBe(gp);
    expect(monaco.tyreWear).toBeGreaterThan(s.tyreWear);   // shorter laps: more wear a km for the same laps
    expect(withCircuit(custom, 'monaco').tyreWear).toBe(custom.tyreWear);
  });
  it('show the tyre wear as tyre life, more life on +', () => {
    const f = ROOM_FIELDS.find((x) => x.key === 'tyreWear')!, s = withPreset(defaultSettings('melbourne'), PRESETS[2]);
    expect(f.shown!(s)).toBe('Softs ~10 laps');
    expect(stepOption(f, 4.5, 1, s)).toBe(4);
    expect(stepOption(f, 4.5, -1, s)).toBe(5);
    expect(stepOption(f, 4.2, 1, s)).toBe(4);     // between steps: the next one that way
    expect(stepOption(f, 4.2, -1, s)).toBe(4.5);
    expect(f.detail!(s)).toContain('mediums 14, hards 20');
    for (const v of TYRE_WEAR) expect(Math.round(v * 10) / 10).toBe(v);   // tenths on the wire
  });
});

describe('the session in words', () => {
  const s = { ...defaultSettings('melbourne'), practice: 2 };
  const se = (o: Partial<SessionInfo>): SessionInfo => ({ ...lobbySession(0), ...o });
  it('says what is on, how long is left and what is next', () => {
    expect(weekendSummary(s)).toBe('2 × 10 min practice · 10 min qualifying · 5 laps · no stops · softs ~45 laps · dry · any car');
    expect(weekendSummary({ ...s, practice: 0, qualifying: 'oneShot', pitStops: 1, weather: 'random', car: 'drift', collisions: false, invalidPenalty: 5 })).toBe(
      'one-shot qualifying · 5 laps · 1 stop · tyres ~60 laps · random · no collisions · 5 s a lap off track · Drift car only');
    expect(sessionTitle(lobbySession(0), s)).toBe('Lobby');
    expect(nextSession(lobbySession(0), s)).toBe('Custom weekend · first: Practice 1');
    expect(nextSession(lobbySession(0), withPreset(s, PRESETS[1]))).toBe('Sprint · first: Qualifying');
    const p1 = se({ phase: 'practice', index: 1, start: 100, end: 700 });
    expect(sessionTitle(p1, s)).toBe('Practice 1 of 2');
    expect(sessionState(p1, s, 125.2)).toEqual({ big: '9:35', text: 'left in the session' });
    expect(nextSession(p1, s)).toBe('Next: Practice 2');
    expect(nextSession({ ...p1, index: 2 }, s)).toBe('Next: Qualifying');
    expect(nextSession({ ...p1, index: 2 }, { ...s, qualifying: 'none' })).toBe('Next: the race, 5 laps');
    const race = se({ phase: 'race', start: 0, lightsAt: 15, goAt: 21 });
    expect(sessionState(race, s, 3).big).toBe('0:12');
    expect(sessionState(race, s, 17).big).toBe('Lights');
    expect(sessionState(race, s, 30, 2).big).toBe('Lap 3/5');
    expect(sessionState(race, s, 30, 5).big).toBe('Lap 5/5');
    expect(sessionTitle({ ...race, stage: 'results' }, s)).toBe('Race results');
  });
});

describe('results tables', () => {
  it('give the winner the time and the others gaps, laps behind, DNF', () => {
    const base = { car: 'lcgt3', grid: 0, best: 80.5, pits: 0, invalid: 0, penalty: 0 };
    const rows = raceRows([
      { ...base, player: 1, name: 'A', status: 'finished', laps: 5, time: 400.25 },
      { ...base, player: 2, name: 'B', status: 'finished', laps: 5, time: 401, penalty: 2 },
      { ...base, player: 3, name: 'C', status: 'finished', laps: 4, time: 390 },
      { ...base, player: 4, name: 'D', status: 'outOfTime', laps: 3, time: 300 },
      { ...base, player: 0, name: 'E', status: 'dnf', laps: 1, time: 90, best: null },
    ]);
    expect(rows.map((r) => r.time)).toEqual(['6:40.250', '+2.750', '+1 lap', 'Out of time', 'DNF']);
    expect(rows.map((r) => r.pos)).toEqual(['1', '2', '3', '4', '—']);
    expect(rows[1].penalty).toBe('+2 s');
    expect(rows[0].car).toBe('GT3');
    expect(rows[4].best).toBe('—');
  });
  it('give a board best laps and gaps', () => {
    const rows = boardRows([{ player: 1, name: 'A', car: 'lcf1', best: 81.25, sectors: [null, null, null], laps: 3 },
      { player: 0, name: 'B', car: 'drift', best: 82, sectors: [null, null, null], laps: 1 }]);
    expect(rows.map((r) => [r.pos, r.best, r.time, r.out])).toEqual([['1', '1:21.250', '1:21.250', false], ['2', '1:22.000', '+0.750', true]]);
  });
});

describe('RoomLog', () => {
  it('keeps the last qualifying board through the race, until the next weekend', () => {
    const net = { board: [], session: lobbySession(0) } as unknown as NetClient;
    const log = new RoomLog(net);
    const entry = { player: 1, name: 'A', car: 'lcf1', best: 80, sectors: [null, null, null], laps: 2 };
    const q = { ...lobbySession(10), phase: 'qualifying' as const }, race = { ...lobbySession(20), phase: 'race' as const };
    const feed = (e: NetEvent) => log.feed(e);
    feed({ type: 'session', session: q, before: lobbySession(0) });
    feed({ type: 'board', board: [entry] });
    feed({ type: 'session', session: race, before: q });
    feed({ type: 'board', board: [] });
    expect(log.qualifying).toEqual([entry]);
    feed({ type: 'session', session: lobbySession(30), before: race });
    expect(log.qualifying).toEqual([entry]);
    feed({ type: 'session', session: { ...lobbySession(40), phase: 'practice', index: 1 }, before: lobbySession(30) });
    expect(log.qualifying).toBeNull();
  });
});

describe('messages', () => {
  it('say why a room could not be entered, and offer the one thing to do', () => {
    expect(joinErrorText(null, 'K7QX', 'ws://r').offer).toBe('retry');
    expect(joinErrorText(ERROR.noRoom, 'K7QX', 'ws://r')).toMatchObject({ offer: 'create' });
    expect(joinErrorText(ERROR.version, 'K7QX', 'ws://r')).toMatchObject({ offer: 'reload' });
    expect(joinErrorText(ERROR.roomFull, 'K7QX', 'ws://r').text).toContain('full');
    expect(joinErrorText(99, 'K7QX', 'ws://r', 'odd').text).toBe('odd');
    expect(closedText('K7QX', 'closed', { code: ERROR.replaced, message: '' })).toContain('another tab');
    expect(closedText('K7QX', 'timeout', null)).toBe('Lost the connection to room K7QX (timeout).');
  });
});
