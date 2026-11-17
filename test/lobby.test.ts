import { describe, expect, it } from 'vitest';
import {
  boardRows, closedText, FIELD_GROUPS, joinErrorText, nextSession, optionLabel, presetOf, PRESETS, raceRows, ROOM_FIELDS, RoomLog,
  sessionState, sessionTitle, stepOption, weekendSummary, withPreset,
} from '../src/lobby';
import { defaultSettings, ERROR, normaliseSettings, type NetClient, type NetEvent, type RoomSettings, SETTING_RANGES, type SessionInfo } from '../src/net';
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
  it('are valid settings, each its own preset, and the default room is one', () => {
    for (const p of PRESETS) {
      const s = withPreset(defaultSettings('monza'), p);
      expect(normaliseSettings(s)).toEqual(s);
      expect(s.circuit).toBe('monza');
      expect(presetOf(s)).toBe(p);
    }
    expect(presetOf(defaultSettings('melbourne'))?.id).toBe('short');
    expect(presetOf({ ...defaultSettings('melbourne'), raceLaps: 7 })).toBeNull();
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  });
  it('keep the allowed car', () => {
    expect(withPreset({ ...defaultSettings('monza'), car: 'lcgt3' }, PRESETS[0]).car).toBe('lcgt3');
  });
});

describe('the session in words', () => {
  const s = { ...defaultSettings('melbourne'), practice: 2 };
  const se = (o: Partial<SessionInfo>): SessionInfo => ({ ...lobbySession(0), ...o });
  it('says what is on, how long is left and what is next', () => {
    expect(weekendSummary(s)).toBe('2 × 10 min practice · 10 min qualifying · 5-lap race');
    expect(weekendSummary({ ...s, practice: 0, qualifying: 'oneShot', pitStops: 1, weather: 'random', car: 'drift', collisions: false })).toBe(
      'one-shot qualifying · 5-lap race · 1 pit stop · random weather · no collisions · Drift car only');
    expect(sessionTitle(lobbySession(0), s)).toBe('Lobby');
    expect(nextSession(lobbySession(0), s)).toBe('First: Practice 1');
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
