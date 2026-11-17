// A race weekend in the game (src/weekend.ts through src/multiplayer.ts): game Sessions joined to an in-process relay
// over the emulated network (test/weekendRoom.ts), every client simulating its own car as the game does.
import { describe, expect, test } from 'vitest';
import { CAR_REASON, COMPOUND, type RoomSettings } from '../src/net';
import { gridSlots } from '../src/raceGeometry';
import { RECOVERY_SECS } from '../src/weekend';
import { DEF, distXZ, full, Room } from './weekendRoom';

describe('a race weekend in the game', () => {
  test('practice, qualifying sets the grid, a race on the grid, laps, a pit stop, a recovery, the finish', async () => {
    const room = new Room();
    const alice = await room.join('Alice', 'lcf1', 'create'), bob = await room.join('Bob', 'lcgt3'), cy = await room.join('Cy', 'drift');
    const all = [alice, bob, cy];
    room.run(0.5);
    for (const c of all) expect(c.mp.players.size).toBe(2);
    // the lobby: tyre wear on (the room's), the time trial's best times kept apart
    for (const c of all) {
      expect(c.s.conditions.wearScale).toBeCloseTo(1 * c.s.car.spec.race.wearScale, 9);
      expect(c.s.storeTag).toBe('.mp');
      expect(c.s.track.pitLane).toBeDefined();
    }
    const settings: Partial<RoomSettings> = { practice: 1, practiceMinutes: 1, qualifying: 'timed', qualifyingMinutes: 2, raceLaps: 2, pitStops: 1,
      tyreWear: 20, collisions: false, grid: 'qualifying', finishSecs: 30 };
    alice.mp.net.setSettings(settings);
    room.run(0.3);
    alice.mp.net.startWeekend();
    room.until(() => all.every((c) => c.mp.weekend.phase === 'practice'), 2, 'practice');
    for (const c of all) {
      expect(c.s.conditions.wearScale).toBeCloseTo(20 * c.s.car.spec.race.wearScale, 9);
      expect(c.mp.takeNotices().some((n) => n.kind === 'flag' && n.text === 'Practice 1')).toBe(true);
    }
    // qualifying: Cy quickest, then Alice, then Bob (laps of about 1.2, 1.5 and 1.8 s)
    room.until(() => all.every((c) => c.mp.weekend.phase === 'qualifying'), 6, 'qualifying');
    for (const c of all) expect(c.s.storeTag).toBe('.mp');
    room.hopLap(cy, 0.4); room.hopLap(alice, 0.5); room.hopLap(bob, 0.6);
    room.run(0.5);
    // a best lap from an earlier race here: not this race's best (the race's store starts empty)
    for (const c of all) localStorage.setItem(DEF.storeKey + c.s.car.spec.storeKey + '.race', JSON.stringify({ bestLap: 1, bestSectors: [0.3, 0.3, 0.4], bestTrace: null, bestLapSectors: null }));
    expect(alice.mp.net.board.map((b) => b.name)).toEqual(['Cy', 'Alice', 'Bob']);
    // the race: every car on its own slot of the same grid, held there until the lights go out
    room.until(() => all.every((c) => c.mp.weekend.phase === 'race'), 15, 'the race');
    room.run(0.2);
    const grid = alice.mp.net.session.grid;
    expect(grid.map((id) => alice.mp.net.players.get(id)!.name)).toEqual(['Cy', 'Alice', 'Bob']);
    const slots = gridSlots(alice.s.track, 32);
    for (const c of all) {
      c.driver = full;   // flat out on the grid: held all the same
      const k = c.mp.net.gridSlot()!, g = slots[k];
      expect(c.s.car.proj.s).toBeCloseTo(g.s, 0); expect(c.s.car.proj.lat).toBeCloseTo(g.lat, 0);
      expect(c.s.storeTag).toBe('.race');
      expect(c.s.timing.store.bestLap).toBeNull();
      expect(c.mp.weekend.held).toBe(true);
      expect(c.mp.weekend.lapState).toEqual({ text: 'ON THE GRID', clock: false });
    }
    const at = all.map((c) => c.s.car.pos.clone());
    let movedEarly = 0;
    room.until(() => alice.mp.weekend.raceStage === 'racing', 10, 'lights out');
    const sawLights = alice.mp.takeNotices().some((n) => n.text === 'LIGHTS OUT');
    // nobody moved before then (the lights ran a second apart: 4 s + the hold)
    for (const [k, c] of all.entries()) { const d = distXZ(c.s.car.pos, at[k]); if (d > 0.5) movedEarly++; }
    expect(movedEarly).toBe(0);
    expect(sawLights).toBe(true);
    for (const c of all) c.driver = null;   // the autopilot drives off the grid and over the line
    expect(alice.mp.weekend.lapState).toEqual({ text: 'LAP 1/2', clock: true });
    room.until(() => all.every((c) => !c.s.timing.standing), 8, 'the first crossing');
    // lap 1: Cy, Alice, Bob in order
    for (const c of [cy, alice, bob]) { room.hopLap(c, 0.4, false); }
    room.run(0.5);
    expect(alice.mp.net.standings.map((s) => [s.name, s.laps])).toEqual([['Cy', 1], ['Alice', 1], ['Bob', 1]]);
    expect(alice.mp.weekend.order.map((e) => e.name)).toEqual(['Cy', 'Alice', 'Bob']);
    // Alice pits for hards: into the lane at 30 m/s (the limiter takes her down to 80 km/h), stops in the box
    const w = alice.mp.weekend, lane = w.lane, tr = alice.s.track;
    expect(Math.max(...alice.s.car.tyreWear)).toBeGreaterThan(0);
    w.nextCompound = 'hard';
    alice.s.car.placeAt(lane.sStart + 5, lane.side * (lane.inner[3] + lane.outer[3]) / 2, 30);
    alice.driver = (car) => {   // follow the lane's middle, flat out, then brake in the box
      const d = w.pit.dist, k = Math.min(lane.n - 1, Math.max(0, Math.round(d / (tr.L / tr.N))));
      const want = lane.side * (lane.inner[k] + lane.outer[k]) / 2, err = want - car.proj.lat;
      const target = Math.sqrt(Math.max(0, 2 * 4 * (lane.box - d))), v = car.speedF;   // a stop at the box's middle
      return { throttle: v < target - 1 ? 0.6 : 0, brake: v > target + 0.5 && v > 0.3 ? 1 : 0, steer: 0, analog: true, steerAngle: Math.max(-0.2, Math.min(0.2, err * 0.05)), autoGears: true };
    };
    room.until(() => w.pit.service > 0, 20, 'the box');
    expect(w.pit.inLane).toBe(true);
    const bobsView = [...bob.mp.players.values()].find((p) => p.info.name === 'Alice')!;
    room.run(0.3);
    expect(bobsView.sample.reason).toBe(CAR_REASON.pits);
    expect(bobsView.collidable).toBe(false);
    room.until(() => w.pit.service === 0, 5, 'the service');
    expect(alice.s.car.compound.id).toBe('hard');
    expect(Math.max(...alice.s.car.tyreWear)).toBe(0);
    room.run(0.5);
    for (const c of all) expect(c.mp.net.standings.find((s) => s.name === 'Alice')!.pits).toBe(1);
    expect(bobsView.sample.compound).toBe(COMPOUND.hard);
    alice.driver = null;
    // the lane's limiter held her to the limit through the limited stretch (checked on a run through it)
    alice.s.car.placeAt(lane.sStart + lane.limIn + 2, lane.side * (lane.inner[40] + lane.outer[40]) / 2, 40);
    let over = 0;
    alice.driver = full;
    room.run(2, () => { if (w.pit.inLane && w.pit.dist > lane.limIn + 40 && w.pit.dist < lane.limOut) over = Math.max(over, alice.s.car.speedF * 3.6); });
    expect(over).toBeGreaterThan(70); expect(over).toBeLessThan(84);
    alice.driver = null;
    // Bob recovers: put back where he is, stopped, held as a ghost; his lap goes on
    room.run(1);
    const bp = bob.s.car.pos.clone(), lapStart = bob.s.timing.lapStart;
    bob.mp.requestRestart();
    expect(distXZ(bob.s.car.pos, bp)).toBeLessThan(6);
    expect(bob.s.timing.lapStart).toBe(lapStart);
    room.run(1);
    expect(Math.abs(bob.s.car.speedF)).toBeLessThan(0.3);
    expect(bob.mp.weekend.recovering).toBeGreaterThan(RECOVERY_SECS - 1.5);
    expect(bob.mp.noCollide).toBe(true);
    room.until(() => bob.mp.weekend.recovering === 0, RECOVERY_SECS, 'the recovery');
    // lap 2: Cy wins on the road, then Alice and Bob; Cy and Bob made no stop (60 s each)
    for (const c of [cy, alice, bob]) room.hopLap(c, 0.4, alice.s.timing.lapStart == null);
    let flags: string[] = [];
    room.until(() => { for (const c of all) for (const n of c.mp.takeNotices()) if (n.kind === 'flag') flags.push(`${c.name}: ${n.text}`); return all.every((c) => c.mp.net.standingsFinal); }, 6, 'the result');
    // the chequered flag is for those still racing: never told to the winner once it has its FINISHED P1
    flags = flags.filter((f) => f.startsWith('Cy:') && /CHEQUERED|FINISHED/.test(f));
    expect(flags).toContain('Cy: FINISHED P1');
    expect(flags.slice(flags.indexOf('Cy: FINISHED P1'))).not.toContain('Cy: CHEQUERED FLAG');
    const result = alice.mp.net.standings.map((s) => [s.name, s.status, s.laps, s.penalty]);
    expect(result).toEqual([['Alice', 'finished', 2, 0], ['Cy', 'finished', 2, 60], ['Bob', 'finished', 2, 60]]);
    for (const c of all) {
      expect(c.mp.net.standings.map((s) => s.name)).toEqual(['Alice', 'Cy', 'Bob']);
      expect(c.mp.weekend.finished).toBe(true);
      expect(c.mp.weekend.reason).toBe(CAR_REASON.finished);
      expect(c.mp.weekend.lapState).toEqual({ text: 'RACE OVER', clock: false });
    }
    // the time trial's best times were never touched; the weekend's laps went under their own keys
    for (const c of all) expect(localStorage.getItem(DEF.storeKey + c.s.car.spec.storeKey)).toBeNull();
    expect(localStorage.getItem(DEF.storeKey + '.drift.mp')).not.toBeNull();
    // leaving the room: the time trial again
    alice.mp.close();
    expect(alice.s.track.pitLane).toBeUndefined();
    expect(alice.s.conditions.wearScale).toBe(0);
    expect(alice.s.storeTag).toBe('');
  }, 240_000);
});
