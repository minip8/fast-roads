import { describe, expect, it } from 'vitest';
import { NetClient, type NetClientOptions, type NetEvent } from '../src/net/client';
import { type LinkConditions, LoopbackNet, type LoopbackPair } from '../src/net/loopback';
import {
  type CarState, decodeMessage, emptyCarState, encodeMessage, ERROR, MSG, type NetMessage, PROTOCOL_VERSION, timeToWire,
} from '../src/net/protocol';
import { COMPOUND, defaultSettings, normaliseSettings, ONE_SHOT_GAP, oneShotRelease } from '../src/net/race';
import { emptySample } from '../src/net/remote';
import { seededRandom } from '../src/net/weather';
import { Relay, type RelayOptions } from '../server/relay';
import { gridOrder } from '../server/weekend';

// Rooms created and joined explicitly, the host, and race weekends (practice, qualifying, race) on the relay
// (server/relay.ts, server/weekend.ts) with NetClients over the emulated network, on short durations: the relay's
// minute is 5 s here, the grid 1 s, so a whole weekend runs in about a minute of emulated time.

const LINK: LinkConditions = { latency: 0.03, jitter: 0.01, loss: 0.02, duplicate: 0.01 };
const FAST: Partial<RelayOptions> = {
  minLapSecs: 1, minute: 5, gridSecs: 1, resultsSecs: 2, overtimeSecs: 5, oneShotPrep: 1, oneShotLimit: 20, hostGrace: 2,
};
type Entry = { c: NetClient; pair: LoopbackPair; events: NetEvent[]; name: string };

class World {
  net = new LoopbackNet(11);
  relay: Relay;
  clients: Entry[] = [];
  t = 0;
  scheduled: (number | null)[] = [];
  private lastUpdate = 0;
  constructor(opt: Partial<RelayOptions> = {}, readonly dt = 1 / 60) {
    this.relay = new Relay({ ...FAST, random: seededRandom(5), schedule: (at) => this.scheduled.push(at), ...opt, now: () => this.net.now });
  }
  join(name: string, o: Partial<NetClientOptions> = {}) {
    const pair = this.net.pair(LINK, LINK);
    this.relay.accept(pair.server);
    const c = new NetClient(pair.client, { room: 'WKND', name, car: 'lcf1', circuit: 'monza', clock: () => this.net.now, ...o });
    const e = { c, pair, events: [] as NetEvent[], name };
    this.clients.push(e);
    return e;
  }
  run(seconds: number) {
    const end = this.t + seconds;
    while (this.t < end - 1e-9) this.step();
  }
  // runs until cond() holds (at most `max` s)
  until(cond: () => boolean, max = 30) {
    const end = this.t + max;
    while (!cond()) { if (this.t > end) throw new Error('timed out'); this.step(); }
  }
  private step() {
    this.t += this.dt;
    this.net.advance(this.t);
    // the relay's own timer: whatever schedule() last asked for, and once a second
    const due = this.scheduled.at(-1);
    if (this.t - this.lastUpdate >= 1 || (due != null && this.t >= due)) { this.relay.update(); this.lastUpdate = this.t; }
    for (const e of this.clients) {
      e.c.update(this.t);
      e.c.sendState(car(this.clients.indexOf(e), this.t), this.t);
      e.events.push(...e.c.takeEvents());
    }
  }
  st(e: Entry) { return e.c.serverTime(this.t); }
}
const car = (k: number, t: number): CarState => ({ ...emptyCarState(), x: 20 * k, z: 50 * t, vz: 50, gear: 4, rpm: 9000 });

// A lap of `time` s ending now, sectors evenly split.
function lap(e: Entry, time: number, valid = true) {
  e.c.sendLap({ time, sectors: [time / 3, time / 3, time - (2 * time) / 3], valid });
}
const errors = (e: Entry) => e.events.flatMap((x) => (x.type === 'error' ? [x] : []));
const lastError = (e: Entry) => errors(e).at(-1);
const phaseOf = (e: Entry) => `${e.c.session.phase}${e.c.session.index || ''}:${e.c.session.stage}`;

describe('rooms', () => {
  it('creates a room, refuses a taken code and a missing room, and joins an existing one', () => {
    const w = new World();
    const a = w.join('Ann', { mode: 'create', room: 'R1', circuit: 'spa' });
    w.run(0.3);
    const clash = w.join('Ben', { mode: 'create', room: 'R1', circuit: 'monza' });
    const missing = w.join('Cat', { mode: 'join', room: 'NOPE' });
    const joiner = w.join('Dan', { mode: 'join', room: 'R1', circuit: 'monza' });
    const either = w.join('Eve', { room: 'R2' });   // the default: join or create
    w.run(1);
    expect(a.c.status).toBe('joined');
    expect(a.c.isHost).toBe(true);
    expect(clash.c.status).toBe('closed');
    expect(lastError(clash)).toMatchObject({ code: ERROR.roomTaken, fatal: true });
    expect(missing.c.status).toBe('closed');
    expect(lastError(missing)).toMatchObject({ code: ERROR.noRoom, fatal: true });
    expect(w.relay.rooms.has('NOPE')).toBe(false);
    expect(joiner.c.status).toBe('joined');
    expect(joiner.c.circuit).toBe('spa');
    expect(joiner.c.settings.circuit).toBe('spa');
    expect(joiner.c.host).toBe(a.c.selfId);
    expect(joiner.c.isHost).toBe(false);
    expect(either.c.isHost).toBe(true);
    expect(either.c.session.phase).toBe('lobby');
    expect(joiner.c.token).not.toBe(0);
    expect(joiner.c.token).not.toBe(a.c.token);
  });

  it('refuses a client of the old protocol with an update-needed error', () => {
    const w = new World();
    const pair = w.net.pair(LINK, LINK);
    w.relay.accept(pair.server);
    const got: NetMessage[] = [];
    let closed = '';
    pair.client.onMessage = (d) => { const m = decodeMessage(d); if (m.ok) got.push(m.msg); };
    pair.client.onClose = (r) => { closed = r; };
    w.run(0.1);
    // a version 1 hello: u16 version 1, then the room, name, car and circuit (no mode, no token)
    pair.client.send('reliable', new Uint8Array([MSG.hello, 1, 0, 1, 65, 1, 65, 4, 108, 99, 102, 49, 0]));
    w.run(0.3);
    expect(got).toEqual([expect.objectContaining({ type: 'error', code: ERROR.version, fatal: true })]);
    expect((got[0] as { message: string }).message).toMatch(/update the game/);
    expect(closed).not.toBe('');
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('moves the host to the longest-present player after a grace, and gives a player back its place with its token', () => {
    const w = new World();
    const a = w.join('Ann', { mode: 'create' });
    w.run(0.3);
    const b = w.join('Ben', { mode: 'join' });
    w.run(0.3);
    const c = w.join('Cat', { mode: 'join' });
    w.run(0.5);
    const [ida, idb] = [a.c.selfId, b.c.selfId];
    expect(c.c.host).toBe(ida);
    a.c.close();
    w.run(1);   // within the grace (2 s): still Ann's, and nobody else may run the room
    expect(b.c.host).toBe(ida);
    b.c.startWeekend();
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.notHost, fatal: false });
    w.run(1.5);
    expect(b.c.host).toBe(idb);
    expect(c.c.host).toBe(idb);
    expect(c.events.find((e) => e.type === 'host')).toMatchObject({ host: idb, before: ida });
    // Ann comes back with her token: the same id, no longer the host
    const a2 = w.join('Ann', { mode: 'join', token: a.c.token });
    w.run(0.5);
    expect(a2.c.selfId).toBe(ida);
    expect(a2.c.token).toBe(a.c.token);
    expect(a2.c.host).toBe(idb);
    // Ben reloads (leaves and rejoins within the grace): still the host
    const token = b.c.token;
    b.c.close();
    w.run(0.5);
    const b2 = w.join('Ben', { mode: 'join', token });
    w.run(0.5);
    expect(b2.c.selfId).toBe(idb);
    expect(b2.c.isHost).toBe(true);
    w.run(3);
    expect(c.c.host).toBe(idb);
    // the same token on a third connection while the second is open: the second is replaced
    const b3 = w.join('Ben', { mode: 'join', token });
    w.run(0.5);
    expect(b2.c.status).toBe('closed');
    expect(lastError(b2)).toMatchObject({ code: ERROR.replaced, fatal: true });
    expect(b3.c.selfId).toBe(idb);
    expect(b3.c.isHost).toBe(true);
    expect(c.events.filter((e) => e.type === 'leave').at(-1)).toMatchObject({ reason: 'replaced' });
    expect([...c.c.players.keys()].sort()).toEqual([ida, idb, c.c.selfId].sort());
  });

  it('with no grace, hands the host role over at once', () => {
    const w = new World({ hostGrace: 0 });
    const a = w.join('Ann'), b = w.join('Ben');
    w.run(0.5);
    a.c.close();
    w.run(0.3);
    expect(b.c.isHost).toBe(true);
  });
});

describe('settings', () => {
  it('lets only the host change them, only in the lobby, clamped, and moves the room to another circuit', () => {
    const w = new World();
    const a = w.join('Ann'), b = w.join('Ben');
    w.run(12);   // long enough for a lap on the board
    lap(b, 10);
    w.run(0.3);
    expect(a.c.board.length).toBe(1);
    b.c.setSettings({ raceLaps: 3 });
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.notHost });
    a.c.setSettings({ raceLaps: 500, practice: 9, practiceMinutes: 0, tyreWear: 2.6, trackLimits: true, finishSecs: 5, qualifying: 'none', grid: 'reversed' });
    w.run(0.3);
    expect(b.c.settings).toMatchObject({ raceLaps: 99, practice: 3, practiceMinutes: 1, tyreWear: 2.5, trackLimits: true, finishSecs: 30, grid: 'joinOrder' });
    expect(a.c.settings).toEqual(b.c.settings);
    a.c.setSettings({ circuit: 'nurburg' });
    a.c.setSettings({ car: 'tank' });
    w.run(0.3);
    expect(errors(a).map((e) => e.code)).toEqual([ERROR.badCircuit, ERROR.badCar]);
    // one car only: switching to another is refused, as is a lap in another
    a.c.setSettings({ car: 'lcgt3' });
    w.run(0.3);
    b.c.setPlayer({ car: 'drift' });
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.badCar, fatal: false });
    expect(a.c.players.get(b.c.selfId)!.car).toBe('lcf1');
    w.run(10.5);
    lap(b, 10);
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.lapRejected });
    b.c.setPlayer({ car: 'lcgt3' });
    w.run(0.3);
    expect(a.c.players.get(b.c.selfId)!.car).toBe('lcgt3');
    // another circuit: the board goes, and every client is told to reload onto it
    a.c.setSettings({ circuit: 'suzuka', car: '' });
    w.run(0.3);
    const ev = b.events.filter((e) => e.type === 'settings').at(-1);
    expect(ev).toMatchObject({ circuitChanged: true, settings: { circuit: 'suzuka' } });
    expect(b.c.circuit).toBe('suzuka');
    expect(b.c.board).toEqual([]);
    expect(w.relay.rooms.get('WKND')!.circuit).toBe('suzuka');
    // out of the lobby: refused
    a.c.startWeekend();
    w.run(0.3);
    a.c.setSettings({ raceLaps: 2 });
    w.run(0.3);
    expect(lastError(a)).toMatchObject({ code: ERROR.badPhase });
    expect(b.c.session.phase).toBe('practice');
  });

  it('normalises settings and orders a grid every way', () => {
    const d = defaultSettings('monza');
    expect(normaliseSettings(d)).toEqual(d);
    expect(normaliseSettings({ ...d, raceLaps: Number.NaN, pitStops: -4, tyreWear: 0, weather: 'snow' as never })).toMatchObject({ raceLaps: 5, pitStops: 0, tyreWear: 0.5, weather: 'dry' });
    const players = [{ id: 4, joinedAt: 3 }, { id: 1, joinedAt: 1 }, { id: 2, joinedAt: 2 }, { id: 9, joinedAt: 0 }];
    const best = new Map([[1, 90], [2, 88], [4, 95]]);   // 9 has no time
    expect(gridOrder('qualifying', players, best, Math.random)).toEqual([2, 1, 4, 9]);
    expect(gridOrder('reversed', players, best, Math.random)).toEqual([4, 1, 2, 9]);
    expect(gridOrder('joinOrder', players, best, Math.random)).toEqual([9, 1, 2, 4]);
    const r1 = gridOrder('random', players, best, seededRandom(1)), r2 = gridOrder('random', players, best, seededRandom(1));
    expect(r1).toEqual(r2);
    expect([...r1].sort()).toEqual([1, 2, 4, 9]);
    const seen = new Set(Array.from({ length: 20 }, (_, k) => gridOrder('random', players, best, seededRandom(k)).join()));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('race weekends', () => {
  it('runs practice, timed qualifying and a race with a grid from qualifying, a missed-stop penalty and a DNF, then the lobby', () => {
    const w = new World();
    const a = w.join('Ann', { mode: 'create' });
    w.run(0.3);
    const b = w.join('Ben', { mode: 'join' }), c = w.join('Cat', { mode: 'join' });
    w.run(1);
    a.c.setSettings({ practice: 1, practiceMinutes: 1, qualifying: 'timed', qualifyingMinutes: 2, raceLaps: 3, grid: 'qualifying',
      pitStops: 1, trackLimits: true, finishSecs: 30, weather: 'changeable' });
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    for (const e of [a, b, c]) expect(phaseOf(e)).toBe('practice1:running');
    const p = a.c.session;
    expect(p.end! - p.start).toBe(5);
    expect(a.c.weather.origin).toBe(p.start);
    expect(a.c.weather.kind).not.toBe(undefined);
    w.run(3);
    lap(b, 3);
    w.run(0.3);
    expect(c.c.board.map((r) => r.name)).toEqual(['Ben']);
    lap(c, 6);   // longer than the session so far (under 4 s, and a second of slack): refused
    w.run(0.2);
    expect(lastError(c)).toMatchObject({ code: ERROR.lapRejected });

    // qualifying: Cat quickest, then Ann, then Ben
    w.until(() => a.c.session.phase === 'qualifying');
    const q = a.c.session;
    w.run(0.1);   // (the board that follows the session message)
    expect(q.start).toBe(p.end);   // on the relay's clock, not when a timer happened to run
    expect(a.c.board).toEqual([]);
    w.run(3);
    lap(c, 2.4); lap(a, 2.6); lap(b, 2.9);
    w.run(3);
    lap(c, 2.5); lap(a, 2.5);   // Ann's second lap improves her best
    w.until(() => a.c.session.stage === 'finishing');
    expect(a.c.session.finishAt).toBe(q.end);
    w.run(1.5);
    lap(a, 1.6);   // under way at the flag: counts
    w.run(1);
    lap(b, 1.1);   // started after the flag (and the relay's second of slack): refused
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.lapRejected });
    expect(a.c.board[0]).toMatchObject({ name: 'Ann', best: 1.6 });
    // the overtime runs out (Ben and Cat never cross again): the race
    w.until(() => a.c.session.phase === 'race');
    const r = a.c.session;
    w.run(0.1);
    expect(r.start).toBe(q.end! + 5);
    expect(r.grid).toEqual([a.c.selfId, c.c.selfId, b.c.selfId]);
    expect(c.c.gridSlot()).toBe(1);
    expect(r.lightsAt).toBe(r.start + 1);
    expect(r.goAt! - r.lightsAt!).toBeGreaterThanOrEqual(4.2);
    expect(r.goAt! - r.lightsAt!).toBeLessThanOrEqual(7);
    expect(a.c.standings.map((s) => s.player)).toEqual(r.grid);
    expect(a.c.raceStage(w.t)).toBe('grid');
    expect(a.c.held(w.t)).toBe(true);
    expect(a.c.collides(b.c.selfId)).toBe(true);
    w.until(() => w.st(a) >= r.lightsAt! + 2.5);
    expect(a.c.raceStage(w.t)).toBe('lights');
    expect(a.c.lightsLit(w.t)).toBe(3);
    lap(b, 1.1);   // before the lights went out
    w.run(0.2);
    expect(lastError(b)).toMatchObject({ code: ERROR.lapRejected });
    expect(b.c.raceLaps()).toBe(0);
    w.until(() => w.st(a) >= r.goAt! + 0.05);
    expect(a.c.raceStage(w.t)).toBe('racing');
    expect(a.c.held(w.t)).toBe(false);
    expect(a.c.lightsLit(w.t)).toBe(0);

    // the race: Ann first over the line but with an invalid lap and no pit stop; Cat stops; Ben retires
    w.until(() => w.st(a) >= r.goAt! + 2.05);
    lap(a, 2); lap(b, 2);
    w.run(0.3);
    expect(c.c.raceLaps(a.c.selfId)).toBe(1);
    expect(c.events.filter((e) => e.type === 'lap' && e.player === a.c.selfId).at(-1)).toMatchObject({ lap: 1 });
    c.c.sendPit({ compound: COMPOUND.hard });
    w.run(0.3);
    c.c.sendPit({ compound: COMPOUND.soft });   // too soon after the last
    w.run(0.2);
    expect(lastError(c)).toMatchObject({ code: ERROR.pitRejected });
    expect(a.events.filter((e) => e.type === 'pit')).toEqual([expect.objectContaining({ player: c.c.selfId, compound: COMPOUND.hard })]);
    w.until(() => w.st(a) >= r.goAt! + 2.15);
    lap(c, 2.1);
    b.c.close();
    w.until(() => w.st(a) >= r.goAt! + 4.05);
    lap(a, 2, false);
    w.until(() => w.st(a) >= r.goAt! + 4.3);
    lap(c, 2.1);
    w.until(() => w.st(a) >= r.goAt! + 6.05);
    lap(a, 2);
    w.run(0.3);
    expect(phaseOf(c)).toBe('race:finishing');
    expect(c.c.session.finishAt).toBeCloseTo(r.goAt! + 6.05, 1);
    expect(c.c.standings.find((s) => s.player === a.c.selfId)!.status).toBe('finished');
    expect(c.c.standings.find((s) => s.player === b.c.selfId)!.status).toBe('dnf');
    lap(a, 2.5);   // a cool-down lap after finishing: not sent at all
    w.until(() => w.st(a) >= r.goAt! + 6.45);
    lap(c, 2.1);   // Cat finishes at her next crossing, and with Ben gone the race is over
    w.run(0.3);
    expect(phaseOf(a)).toBe('race:results');
    expect(a.c.standingsFinal).toBe(true);
    const res = a.c.standings;
    expect(res.map((s) => [s.name, s.status, s.laps, s.pits, s.invalid, s.penalty])).toEqual([
      ['Cat', 'finished', 3, 1, 0, 0],
      ['Ann', 'finished', 3, 0, 1, 60],   // 60 s for the missed stop; the invalid lap costs no time (track limits are the car's)
      ['Ben', 'dnf', 1, 0, 0, 0],
    ]);
    expect(res[1].time! < res[0].time!).toBe(true);   // Ann crossed first, but the missed stop puts her behind
    expect(res[0].best).toBeCloseTo(2.1, 5);
    expect(errors(a).length).toBe(0);
    // results, then the lobby with the results kept
    w.until(() => a.c.session.phase === 'lobby');
    w.run(0.1);
    expect(a.c.standingsFinal).toBe(true);
    expect(a.c.standings.map((s) => s.name)).toEqual(['Cat', 'Ann', 'Ben']);
    expect(a.c.board).toEqual([]);
    expect(a.c.weather.kind).toBe('dry');
    const phases = c.events.flatMap((e) => (e.type === 'session' ? [`${e.session.phase}${e.session.index || ''}:${e.session.stage}`] : []));
    expect(phases).toEqual(['practice1:running', 'qualifying:running', 'qualifying:finishing', 'race:running', 'race:finishing', 'race:results', 'lobby:running']);
    // a late joiner sees the last results in the welcome
    const late = w.join('Late', { mode: 'join' });
    w.run(0.5);
    expect(late.c.standings.map((s) => s.name)).toEqual(['Cat', 'Ann', 'Ben']);
  });

  it('runs one-shot qualifying: one lap each, released one at a time, ghosts, then the grid by it', () => {
    const w = new World();
    const a = w.join('Ann'), b = w.join('Ben'), c = w.join('Cat');
    w.run(1);
    a.c.setSettings({ practice: 0, qualifying: 'oneShot', raceLaps: 1, grid: 'qualifying' });
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    const s = a.c.session;
    expect([s.phase, s.oneShot, s.collisions]).toEqual(['qualifying', true, false]);
    expect(s.goAt).toBe(s.start + 1);
    expect([...s.grid].sort()).toEqual([a, b, c].map((e) => e.c.selfId).sort());
    expect(a.c.collides(b.c.selfId)).toBe(false);
    expect(a.c.sample(b.c.selfId, w.t, emptySample())!.collidable).toBe(false);
    expect(a.c.held(w.t)).toBe(true);
    // released in the session's (join) order ONE_SHOT_GAP apart; the session's end allows for the last release
    expect(s.grid.map((id) => oneShotRelease(s, id))).toEqual([0, 1, 2].map((k) => s.goAt! + k * ONE_SHOT_GAP));
    expect(oneShotRelease(s, 99)).toBeNull();
    expect(s.end).toBe(s.goAt! + 2 * ONE_SHOT_GAP + 20);
    const late = w.join('Late');
    w.run(0.5);
    w.until(() => w.st(a) >= s.goAt! + 3.05);
    const first = [a, b, c].find((e) => e.c.selfId === s.grid[0])!, others = [a, b, c].filter((e) => e !== first);
    expect([first, ...others, late].map((e) => e.c.held(w.t))).toEqual([false, true, true, false]);
    lap(b, 3); lap(a, 2.9, false); lap(late, 2);
    w.run(0.3);
    expect(lastError(late)).toMatchObject({ code: ERROR.lapRejected });
    lap(b, 0.25 + 1);   // a second lap: one only
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.lapRejected });
    expect(a.c.session.phase).toBe('qualifying');
    w.until(() => w.st(a) >= s.goAt! + 4.5);
    lap(c, 4.4);   // the last one in: the session ends there
    w.run(0.3);
    expect(a.c.session.phase).toBe('race');
    // Ben and Cat had valid laps (Ben quicker); Ann's was invalid, so she starts behind them; Late joined after it began
    expect(a.c.session.grid).toEqual([b.c.selfId, c.c.selfId, a.c.selfId, late.c.selfId]);
    expect(a.c.collides(b.c.selfId)).toBe(true);
  });

  it('admits a newcomer mid-race as a spectator, and gives a player who comes back its race', () => {
    const w = new World();
    const a = w.join('Ann'), b = w.join('Ben');
    w.run(1);
    a.c.setSettings({ practice: 0, qualifying: 'none', raceLaps: 2, collisions: true });
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    expect(a.c.session.phase).toBe('race');
    expect(a.c.session.grid).toEqual([a.c.selfId, b.c.selfId]);   // join order
    const s = a.c.session;
    w.until(() => w.st(a) >= s.goAt! + 1);
    const d = w.join('Dan');
    w.run(0.5);
    expect(d.c.session.phase).toBe('race');
    expect(d.c.isSpectator()).toBe(true);
    expect(a.c.isSpectator(d.c.selfId)).toBe(true);
    expect(a.c.collides(d.c.selfId)).toBe(false);
    expect(d.c.collides(a.c.selfId)).toBe(false);
    expect(a.c.sample(d.c.selfId, w.t, emptySample())!.collidable).toBe(false);
    expect(a.c.sample(b.c.selfId, w.t, emptySample())!.collidable).toBe(true);
    expect(d.c.held(w.t)).toBe(false);
    const sent = d.c.stats.sentMessages;
    lap(d, 1);   // NetClient does not send a spectator's lap
    expect(d.c.stats.sentMessages).toBe(sent);
    d.pair.client.send('reliable', encodeMessage({ type: 'lap', player: 0, lap: 1, crossingWire: timeToWire(w.st(d)), time: 1, sectors: [0.3, 0.3, 0.4], valid: true }));
    w.run(0.3);
    expect(lastError(d)).toMatchObject({ code: ERROR.lapRejected, message: expect.stringMatching(/spectating/) });
    expect(a.c.standings.map((x) => x.player)).toEqual([a.c.selfId, b.c.selfId]);
    // Ben drops out and comes back with his token: racing again, his lap kept
    w.until(() => w.st(b) >= s.goAt! + 2.05);
    lap(b, 2);
    w.run(0.3);
    const token = b.c.token, idb = b.c.selfId;
    b.c.close();
    w.run(0.3);
    expect(a.c.standings.find((x) => x.player === idb)!.status).toBe('dnf');
    const b2 = w.join('Ben', { mode: 'join', token });
    w.run(0.5);
    expect(b2.c.selfId).toBe(idb);
    expect(b2.c.isSpectator()).toBe(false);
    expect(a.c.standings.find((x) => x.player === idb)).toMatchObject({ status: 'racing', laps: 1 });
    w.until(() => w.st(b2) >= s.goAt! + 4.1);
    lap(b2, 2);   // its first lap on the new connection: lap 1 of the client, 2 of the race
    w.run(0.3);
    expect(phaseOf(a)).toBe('race:finishing');
    expect(a.c.standings[0]).toMatchObject({ player: idb, laps: 2, status: 'finished' });
    // the host ends the race: Ann, still racing, runs out of time
    a.c.skipSession();
    w.run(0.3);
    expect(phaseOf(a)).toBe('race:results');
    expect(a.c.standings.map((x) => [x.player, x.status])).toEqual([[idb, 'finished'], [a.c.selfId, 'outOfTime']]);
    a.c.skipSession();
    w.run(0.3);
    expect(phaseOf(a)).toBe('lobby:running');
  });

  it('lets the host skip each session and abort the weekend', () => {
    const w = new World();
    const a = w.join('Ann'), b = w.join('Ben');
    w.run(1);
    a.c.skipSession();
    w.run(0.3);
    expect(lastError(a)).toMatchObject({ code: ERROR.badPhase });
    a.c.setSettings({ practice: 2, practiceMinutes: 10, qualifying: 'timed', qualifyingMinutes: 10, raceLaps: 5 });
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    expect(lastError(a)).toMatchObject({ code: ERROR.badPhase });
    const seen: string[] = [phaseOf(b)];
    for (let k = 0; k < 4; k++) { a.c.skipSession(); w.run(0.3); seen.push(phaseOf(b)); }
    expect(seen).toEqual(['practice1:running', 'practice2:running', 'qualifying:running', 'race:running', 'race:results']);
    expect(b.c.standingsFinal).toBe(true);
    expect(b.c.standings.every((s) => s.status === 'outOfTime')).toBe(true);
    a.c.abortWeekend();
    w.run(0.3);
    expect(phaseOf(b)).toBe('lobby:running');
    a.c.startWeekend();
    w.run(0.3);
    b.c.abortWeekend();
    w.run(0.3);
    expect(lastError(b)).toMatchObject({ code: ERROR.notHost });
    a.c.abortWeekend();
    w.run(0.3);
    expect(phaseOf(b)).toBe('lobby:running');
    expect(b.c.standings.map((s) => s.status)).toEqual(['outOfTime', 'outOfTime']);   // the last finished race's result
  });

  it('refuses bad and out-of-order lap reports and pit stops', () => {
    const w = new World();
    const a = w.join('Ann'), b = w.join('Ben');
    w.run(8);
    const raw = (m: NetMessage) => a.pair.client.send('reliable', encodeMessage(m));
    const lapAt = (n: number, crossing: number, time = 2) =>
      raw({ type: 'lap', player: 0, lap: n, crossingWire: timeToWire(crossing), time, sectors: [time / 2, time / 2, null], valid: false });
    const refused = () => errors(a).filter((e) => e.code === ERROR.lapRejected).map((e) => e.message);
    lapAt(1, w.st(a) + 3);     // in the future
    lapAt(1, w.st(a) - 20);    // long ago
    w.run(0.3);
    lapAt(1, w.st(a));         // fine
    w.run(2.5);
    lapAt(1, w.st(a));         // the same number again
    lapAt(2, w.st(a) - 2.6);   // before the last crossing
    lapAt(2, w.st(a), 0.5);    // under the minimum
    w.run(0.3);
    lapAt(3, w.st(a));         // fine (numbers may skip)
    w.run(0.3);
    expect(refused().length).toBe(5);
    expect(refused()[0]).toMatch(/future/);
    expect(refused()[1]).toMatch(/long ago/);
    expect(refused()[2]).toMatch(/out of order/);
    expect(refused()[3]).toMatch(/before the last/);
    expect(b.events.filter((e) => e.type === 'lap').map((e) => e.type === 'lap' && e.lap)).toEqual([1, 3]);
    // pit stops: in the future, then one in a race before the start
    raw({ type: 'pit', player: 0, timeWire: timeToWire(w.st(a) + 5), compound: 1 });
    w.run(0.3);
    a.c.setSettings({ practice: 0, qualifying: 'none' });
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    a.c.sendPit({ compound: COMPOUND.medium });
    w.run(0.3);
    expect(errors(a).filter((e) => e.code === ERROR.pitRejected).map((e) => e.message)).toEqual(['pit stop time out of range', 'before the start']);
    expect(b.events.some((e) => e.type === 'pit')).toBe(false);
    expect(a.c.status).toBe('joined');
  });

  it('meets deadlines on the clock and asks for a timer, and an empty race ends itself', () => {
    const w = new World({}, 1 / 30);
    const a = w.join('Ann'), b = w.join('Ben');
    w.run(1);
    a.c.setSettings({ practice: 1, practiceMinutes: 1, qualifying: 'none', raceLaps: 3 });
    w.run(0.3);
    a.c.startWeekend();
    w.run(0.3);
    const end = a.c.session.end!;
    expect(w.scheduled.at(-1)).toBe(end);
    w.until(() => a.c.session.phase === 'race');
    expect(a.c.session.start).toBe(end);
    expect(w.scheduled.at(-1)).toBe(a.c.session.end);
    a.c.close(); b.c.close();
    w.run(0.5);
    // both gone: every car retired, so the race is over (results), and then the lobby, with nobody there
    const room = w.relay.rooms.get('WKND')!;
    expect(room.session.stage).toBe('results');
    w.run(3);
    expect(room.session.phase).toBe('lobby');
    expect(room.results!.map((s) => s.status)).toEqual(['dnf', 'dnf']);
  });

  it('sends weather keyframes made from the session seed, and more of them when a session runs long', () => {
    const w = new World({ minute: 60 }, 0.25);
    const a = w.join('Ann');
    w.run(1);
    a.c.setSettings({ practice: 1, practiceMinutes: 120, weather: 'wet' });
    w.run(0.5);
    a.c.startWeekend();
    w.run(0.5);
    const s = a.c.session, wx = a.c.weather;
    expect(wx.origin).toBe(s.start);
    expect(wx.kind).toBe('wet');
    expect(wx.keys.length).toBe(64);
    expect(wx.keys.at(-1)!.t).toBe(63 * 60);
    const c0 = a.c.conditions(w.t);
    expect(c0.wet).toBeGreaterThan(0.5);
    const before = a.events.filter((e) => e.type === 'weather').length;
    w.until(() => a.c.weather.keys[0].t > 0, 63 * 60);
    expect(a.events.filter((e) => e.type === 'weather').length).toBe(before + 1);
    expect(w.st(a) - s.start).toBeGreaterThan(53 * 60 - 2);
    expect(w.st(a) - s.start).toBeLessThan(53 * 60 + 2);
    expect(a.c.weather.keys[0].t).toBe((53 - 2) * 60);
    expect(a.c.weather.keys.at(-1)!.t).toBe((53 - 2 + 63) * 60);
    expect(a.c.status).toBe('joined');
  }, 30_000);
});
