// One-shot qualifying in the game (src/weekend.ts): the entrants wait in the pit lane and go out one at a time,
// ONE_SHOT_GAP s apart in the session's order, each only once the start spot is clear; a car whose lap is done goes
// back to the pits. Two, three and eight entrants, through the relay (test/weekendRoom.ts).
import { describe, expect, test } from 'vitest';
import { CAR_REASON, ONE_SHOT_GAP, oneShotRelease } from '../src/net';
import { inPitLane } from '../src/track';
import { type Client, distXZ, FAST, Room } from './weekendRoom';

const inLane = (c: Client) => inPitLane(c.s.track, c.s.car.pos.x, c.s.car.pos.z);
const serverT = (c: Client, room: Room) => c.mp.net.serverTime(room.t);

// Each entrant's release (relay time), recorded as it happens; and at every tick, how many cars were out of the pit
// lane at once.
function watch(room: Room, cs: Client[]) {
  const released = new Map<string, number>();
  let mostOut = 0;
  const every = () => {
    let out = 0;
    for (const c of cs) {
      const w = c.mp.weekend;
      if (w.phase !== 'qualifying') continue;
      if (!released.has(c.name) && !w.held && !w.finished) released.set(c.name, serverT(c, room));
      if (!inLane(c)) out++;
    }
    mostOut = Math.max(mostOut, out);
  };
  return { released, every, mostOut: () => mostOut };
}

describe('one-shot qualifying', () => {
  test('two entrants: out one at a time from the pit lane, one lap each, back to the pits; a wet race on wets; a joiner spectates', async () => {
    const room = new Room();
    const a = await room.join('Ann', 'lcf1', 'create'), b = await room.join('Ben', 'lcgt3');
    room.run(0.3);
    a.mp.net.setSettings({ practice: 0, qualifying: 'oneShot', raceLaps: 1, weather: 'wet', tyreWear: 5 });
    room.run(0.3);
    a.mp.net.startWeekend();
    room.until(() => [a, b].every((c) => c.mp.weekend.phase === 'qualifying'), 2, 'qualifying');
    room.run(0.2);
    const s = a.mp.net.session;
    expect(s.end).toBe(s.goAt! + ONE_SHOT_GAP + FAST.oneShotLimit!);   // the relay allows for the second release
    for (const c of [a, b]) {
      expect(c.mp.weekend.held).toBe(true);
      expect(Math.abs(c.s.car.speedF)).toBeLessThan(0.2);
      expect(inLane(c)).toBe(true);   // waiting in the pit lane, off the racing line
      expect(c.mp.weekend.lapState).toEqual({ text: 'IN THE PITS', clock: false });
      expect(c.mp.weekend.reason).toBe(CAR_REASON.pits);
      // the relay's weather in the physics: a wet track, and wets fitted for it
      expect(c.s.conditions.wetness).toBeGreaterThan(0.6);
      expect(c.s.car.compound.id).toBe('wet');
    }
    expect(distXZ(a.s.car.pos, b.s.car.pos)).toBeGreaterThan(6);   // their own spots
    expect(a.mp.takeNotices().find((n) => n.text === 'ONE-SHOT QUALIFYING')?.sub).toMatch(/you go out 1st of 2/);
    expect(b.mp.takeNotices().find((n) => n.text === 'ONE-SHOT QUALIFYING')?.sub).toMatch(/you go out 2nd of 2, in 2\d s/);
    expect(b.mp.weekend.oneShotIn(room.t)).toBeGreaterThan(ONE_SHOT_GAP);
    const w = watch(room, [a, b]);
    room.until(() => !a.mp.weekend.held, 3, 'the first release');
    room.run(0.1, w.every);
    // Ann at the start spot at speed, Ben still waiting; Ben's HUD names Ann on track
    expect(a.s.car.speedF).toBeGreaterThan(20); expect(a.mp.noCollide).toBe(true);
    expect(Math.abs(a.s.car.proj.s - a.s.startS)).toBeLessThan(20);
    expect(b.mp.weekend.held).toBe(true); expect(inLane(b)).toBe(true);
    room.run(0.5, w.every);
    expect(b.mp.weekend.oneShotRunners(room.t).map((r) => r.state)).toEqual(['out', 'waiting']);
    // one lap: then back to her spot in the pits, held; a second lap is not sent
    room.hopLap(a, 0.4);
    room.run(0.2, w.every);
    expect(a.mp.stats.lapsSent).toBe(1);
    expect(a.mp.weekend.finished).toBe(true);
    expect(inLane(a)).toBe(true); expect(a.mp.weekend.held).toBe(true);
    expect(a.mp.weekend.lapState).toEqual({ text: 'SESSION OVER', clock: false });
    room.hopLap(a, 0.4, false);
    expect(a.mp.stats.lapsSent).toBe(1);
    room.run(0.5, w.every);
    expect(b.mp.weekend.oneShotRunners(room.t).map((r) => r.state)).toEqual(['done', 'waiting']);
    // Ben goes out at his time (the start spot is clear), ONE_SHOT_GAP after Ann
    room.until(() => !b.mp.weekend.held, ONE_SHOT_GAP + 1, 'the second release');
    room.run(0.1, w.every);
    expect(w.released.get('Ben')! - oneShotRelease(s, b.mp.net.selfId)!).toBeLessThan(0.1);
    expect(w.released.get('Ben')! - w.released.get('Ann')!).toBeGreaterThan(ONE_SHOT_GAP - 0.2);
    room.hopLap(b, 0.5);
    room.until(() => a.mp.weekend.phase === 'race', 5, 'the race');
    expect(a.mp.net.session.grid.map((id) => a.mp.net.players.get(id)!.name)).toEqual(['Ann', 'Ben']);
    // a joiner during the race: on track as a ghost spectator, not on the grid
    room.until(() => a.mp.weekend.raceStage === 'racing', 10, 'lights out');
    // (both were in the pit lane when qualifying ended: leaving it for the grid is no drive-through)
    for (const x of [a, b]) expect(x.mp.takeNotices().filter((n) => /Drive-through/.test(n.text))).toEqual([]);
    const c = await room.join('Cat', 'drift');
    room.run(0.5);
    expect(c.mp.weekend.spectator).toBe(true);
    expect(c.mp.weekend.reason).toBe(CAR_REASON.spectator);
    expect(inPitLane(c.s.track, c.s.car.pos.x, c.s.car.pos.z)).toBe(false);
    room.hopLap(c, 0.4);
    expect(c.mp.stats.lapsSent).toBe(1);   // counted by us, but NetClient does not send a spectator's laps
    expect(a.mp.net.standings.map((st) => st.name)).toEqual(['Ann', 'Ben']);
  }, 120_000);

  test('three entrants: a car due out waits while one on its lap comes past the start spot', async () => {
    const room = new Room();
    const a = await room.join('Ann', 'lcgt3', 'create'), b = await room.join('Ben', 'lcgt3'), c = await room.join('Cat', 'lcgt3');
    const all = [a, b, c];
    room.run(0.3);
    a.mp.net.setSettings({ practice: 0, qualifying: 'oneShot', raceLaps: 1 });
    room.run(0.3);
    a.mp.net.startWeekend();
    room.until(() => all.every((x) => x.mp.weekend.phase === 'qualifying'), 2, 'qualifying');
    const s = a.mp.net.session, w = watch(room, all);
    expect(s.end).toBe(s.goAt! + 2 * ONE_SHOT_GAP + FAST.oneShotLimit!);
    const rel = (x: Client) => oneShotRelease(s, x.mp.net.selfId)!;
    expect(all.map(rel)).toEqual([0, 1, 2].map((k) => s.goAt! + k * ONE_SHOT_GAP));
    room.until(() => !a.mp.weekend.held, 3, 'the first release');
    // Ann on her lap comes round to the start spot just as Ben is due: 300 m before it at 25 m/s, the autopilot driving
    room.until(() => serverT(a, room) >= rel(b) - 1, ONE_SHOT_GAP, 'before the second release');
    a.s.car.placeAt((a.s.startS - 300 + a.s.track.L) % a.s.track.L, 0, 25);
    let pastAtRelease: number | null = null;
    const L = a.s.track.L, past = () => ((a.s.car.proj.s - a.s.startS) % L + L) % L;
    room.until(() => { w.every(); if (pastAtRelease == null && !b.mp.weekend.held) pastAtRelease = past(); return pastAtRelease != null; }, 30, 'the second release');
    // Ben went out once Ann was 200 m past the start spot (the remote car is drawn about a round trip late)
    expect(w.released.get('Ben')!).toBeGreaterThan(rel(b) + 4);
    expect(pastAtRelease!).toBeGreaterThan(190); expect(pastAtRelease!).toBeLessThan(400);
    expect(c.mp.weekend.held).toBe(true); expect(inLane(c)).toBe(true);
    room.hopLap(a, 0.4, false);   // Ann's lap done: back to the pits
    room.run(0.2);
    expect(inLane(a)).toBe(true);
    room.hopLap(b, 0.4);
    room.until(() => !c.mp.weekend.held, ONE_SHOT_GAP, 'the third release');
    room.run(0.1, w.every);
    expect(w.released.get('Cat')! - rel(c)).toBeLessThan(0.1);   // on time: the start spot was clear
    room.hopLap(c, 0.4);
    room.until(() => a.mp.weekend.phase === 'race', 3, 'the race');
    expect(a.mp.net.session.grid.length).toBe(3);
  }, 120_000);

  test('eight entrants: out in the session order, 20 s apart, never two out at once, and all timed before the session ends', async () => {
    const room = new Room();
    const cs: Client[] = [];
    for (let k = 0; k < 8; k++) cs.push(await room.join(`P${k}`, 'lcgt3', k ? 'join' : 'create'));
    room.run(0.3);
    cs[0].mp.net.setSettings({ practice: 0, qualifying: 'oneShot', raceLaps: 1 });
    room.run(0.3);
    cs[0].mp.net.startWeekend();
    room.until(() => cs.every((x) => x.mp.weekend.phase === 'qualifying'), 2, 'qualifying');
    room.run(0.3);
    const s = cs[0].mp.net.session, w = watch(room, cs);
    expect(s.grid).toEqual(cs.map((x) => x.mp.net.selfId));   // join order
    expect(s.end).toBe(s.goAt! + 7 * ONE_SHOT_GAP + FAST.oneShotLimit!);
    // eight spots in the pit lane, apart
    for (let i = 0; i < 8; i++) {
      expect(inLane(cs[i])).toBe(true);
      for (let j = i + 1; j < 8; j++) expect(distXZ(cs[i].s.car.pos, cs[j].s.car.pos)).toBeGreaterThan(4);
    }
    // (a car waiting or done is not simulated here: the test's shortcut; the release check still runs every frame)
    room.idle = (x) => { const wk = x.mp.weekend, n = wk.oneShotIn(room.t); return (n != null && n > 0.3) || (wk.finished && inLane(x) && Math.abs(x.s.car.speedF) < 0.3); };
    for (const x of cs) {
      room.until(() => { w.every(); return !x.mp.weekend.held; }, ONE_SHOT_GAP + 2, `${x.name}'s release`);
      room.run(0.1, w.every);
      room.hopLap(x, 0.4);
      room.run(0.2, w.every);
      expect(x.mp.stats.lapsSent).toBe(1);
      expect(x.mp.weekend.finished || x.mp.weekend.phase === 'race').toBe(true);   // (the last one in starts the race)
    }
    room.until(() => cs[0].mp.weekend.phase === 'race', 3, 'the race');
    room.idle = null;
    expect(w.mostOut()).toBe(1);
    const times = cs.map((x) => w.released.get(x.name)!);
    for (let k = 0; k < 8; k++) expect(times[k] - (s.goAt! + k * ONE_SHOT_GAP)).toBeLessThan(0.1);
    expect(cs[0].mp.net.session.grid.length).toBe(8);
    expect(cs[0].mp.net.session.start).toBeLessThan(s.end!);   // every entrant's lap in: the race began before the deadline
  }, 120_000);
});
