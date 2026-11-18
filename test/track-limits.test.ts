// Track limits in a race (src/strikes.ts through src/weekend.ts; docs/net.md, **Track limits in a race**): a strike for
// each excursion beyond the track limits, every third a spell on the pit limiter once the car is back on the track,
// nothing outside a race or with the room's rule off. A game Session in a room of its own (test/weekendRoom.ts).
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import { DT } from '../src/config';
import { LIMITER_PENALTY_SECS, type RoomSettings, STRIKES_PER_PENALTY } from '../src/net';
import { PIT } from '../src/raceGeometry';
import { Strikes } from '../src/strikes';
import type { DriveInput } from '../src/vehicle';
import { type Client, full, Room } from './weekendRoom';

const LIMIT = PIT.limitKmh / 3.6;
const WEEKEND: Partial<RoomSettings> = { practice: 1, practiceMinutes: 1, qualifying: 'none', grid: 'joinOrder', raceLaps: 5, pitStops: 0, finishSecs: 30 };

// A point well into the run-off on the left, halfway round (far from the pit lane), and the road's middle there.
function offTrack(c: Client) {
  const tr = c.s.track;
  for (let i = Math.round(tr.N * 0.4); i < tr.N * 0.9; i++) {
    if (tr.barL[i] - tr.WL[i] > 10) return { s: tr.S[i], out: tr.WL[i] + 5, mid: (tr.WL[i] - tr.WR[i]) / 2 };
  }
  throw new Error('no run-off');
}
const flags = (c: Client) => c.mp.takeNotices().filter((n) => n.kind === 'flag').map((n) => n.text);

async function raceRoom(trackLimits: boolean) {
  const room = new Room();
  const c = await room.join('Alice', 'lcgt3', 'create');
  room.run(0.3);
  c.mp.net.setSettings({ ...WEEKEND, trackLimits });
  room.run(0.3);
  c.mp.net.startWeekend();
  return { room, c, spot: offTrack(c) };
}

describe('track limits in a race', () => {
  test('a strike each excursion; the third brings the limiter, once back on track, only above the pit limit', async () => {
    const { room, c, spot } = await raceRoom(true);
    const w = c.mp.weekend;
    // practice: off the track deletes the lap, as ever, but is no strike
    room.until(() => w.phase === 'practice', 3, 'practice');
    c.driver = full;
    c.s.car.placeAt(spot.s, spot.out, 0);
    room.run(0.5);
    expect(c.s.car.wheels.every((x) => x.out)).toBe(true);
    expect(w.strikes.count).toBe(0);
    expect(flags(c).some((f) => f.startsWith('TRACK LIMITS'))).toBe(false);
    // the race
    c.driver = null;
    room.until(() => w.phase === 'race', 10, 'the race');
    room.until(() => w.raceStage === 'racing' && !w.held, 10, 'lights out');
    flags(c);
    // two excursions: one strike each, however long the car stays out (and a wheel back in for a moment is not back)
    const stopped: (car: unknown, t: number) => DriveInput = () => ({ throttle: 0, brake: 1, steer: 0, analog: true, steerAngle: 0, autoGears: true });
    c.driver = stopped;
    for (let k = 1; k < STRIKES_PER_PENALTY; k++) {
      c.s.car.placeAt(spot.s, spot.out, 0);
      room.run(0.4);
      c.s.car.placeAt(spot.s, spot.mid, 0);
      room.run(0.1);
      c.s.car.placeAt(spot.s, spot.out, 0);
      room.run(0.4);
      expect(w.strikes.count).toBe(k);
      c.s.car.placeAt(spot.s, spot.mid, 0);
      room.run(1);
      expect(w.strikes.count).toBe(k);
    }
    expect(flags(c)).toEqual(['TRACK LIMITS 1/3', 'TRACK LIMITS 2/3']);
    // the third: the penalty, waiting while the car is off the track
    c.s.car.placeAt(spot.s, spot.out, 0);
    room.run(2);
    expect(w.strikes.count).toBe(0);
    expect(w.strikes.pending).toBe(true);
    expect(w.strikes.serving).toBe(false);
    expect(flags(c)).toEqual(['TRACK LIMITS 3/3']);
    // back on the track, rolling at 40 km/h: the limiter starts and leaves the throttle alone below the limit
    let last: DriveInput | null = null;
    const input = w.input.bind(w);
    w.input = (inp, tickAt, parked) => (last = input(inp, tickAt, parked));
    let asked: DriveInput | null = null;   // what the driver (the autopilot) wanted this tick
    c.driver = (car) => (asked = autopilot(car, c.s.track));
    let served = 0;
    const count = () => { if (w.strikes.serving) served++; };
    c.s.car.placeAt(spot.s, spot.mid, 40 / 3.6);
    room.run(0.8, count);   // (back for REJOIN_SECS, 0.5 s, first)
    expect(w.strikes.serving).toBe(true);
    expect(flags(c)).toEqual(['LIMITER PENALTY']);
    expect(c.s.car.speedF).toBeLessThan(LIMIT);
    expect(last!.throttle).toBe(asked!.throttle);
    expect(last!.throttle).toBeGreaterThan(0);
    // above the limit: no throttle, and no brake from the game (the driver's own braking for the corners only)
    c.s.car.placeAt(spot.s, spot.mid, LIMIT + 15);
    let cut = 0, pushed = 0, braked = 0;
    room.run(LIMITER_PENALTY_SECS, () => {
      count();
      if (!w.strikes.serving) return;
      const v = c.s.car.speedF;
      if (last!.brake !== asked!.brake) braked++;
      if (v > LIMIT + 0.5 && asked!.throttle > 0) { if (last!.throttle === 0) cut++; else pushed++; }
    });
    expect(cut).toBeGreaterThan(30);
    expect(pushed).toBe(0);
    expect(braked).toBe(0);
    // served: LIMITER_PENALTY_SECS of driving
    expect(w.strikes.serving).toBe(false);
    expect(Math.abs(served * DT - LIMITER_PENALTY_SECS)).toBeLessThan(2.5 * DT);
    expect(w.strikes.count).toBe(0);   // (the car stayed on the road)
    c.s.car.placeAt(spot.s, spot.mid, LIMIT + 5);
    room.run(0.2);
    expect(last!.throttle).toBe(asked!.throttle);
    expect(last!.throttle).toBeGreaterThan(0);
    // the strikes start again from zero
    expect(w.strikes.count).toBe(0);
    c.driver = stopped;
    c.s.car.placeAt(spot.s, spot.out, 0);
    room.run(0.3);
    expect(w.strikes.count).toBe(1);
    expect(w.addStrike('Pit lane speeding')).toBe(true);   // (another rule's strike counts towards the same penalty)
    expect(w.strikes.count).toBe(2);
    expect(flags(c)).toEqual(['TRACK LIMITS 1/3', 'PIT LANE SPEEDING 2/3']);
  }, 120_000);

  test('the room setting off: no strikes in the race', async () => {
    const { room, c, spot } = await raceRoom(false);
    const w = c.mp.weekend;
    room.until(() => w.phase === 'race', 14, 'the race');
    room.until(() => w.raceStage === 'racing' && !w.held, 10, 'lights out');
    for (let k = 0; k < STRIKES_PER_PENALTY + 1; k++) {
      c.s.car.placeAt(spot.s, spot.out, 0);
      room.run(0.4);
      c.s.car.placeAt(spot.s, spot.mid, 0);
      room.run(0.7);
    }
    expect(w.strikes.count).toBe(0);
    expect(w.strikes.pending || w.strikes.serving).toBe(false);
    expect(w.addStrike('Track limits')).toBe(false);
    expect(flags(c).some((f) => /TRACK LIMITS|LIMITER/.test(f))).toBe(false);
  }, 120_000);
});

describe('Strikes', () => {
  test('counts to the penalty, which waits for the track and the driving', () => {
    const notes: string[] = [];
    const k = new Strikes((_, text, sub) => notes.push(`${text}|${sub ?? ''}`), LIMIT);
    for (let j = 0; j < STRIKES_PER_PENALTY; j++) k.add('Track limits');
    expect(k.pending).toBe(true);
    expect(notes.at(-1)).toMatch(/^TRACK LIMITS 3\/3\|Penalty: 3 s on the pit limiter/);
    k.tick(DT, false, true);
    k.tick(DT, true, false);   // (back, but held still: a recovery)
    expect(k.serving).toBe(false);
    k.tick(DT, true, true);
    expect(k.serving).toBe(true);
    const inp: DriveInput = { throttle: 0.8, brake: 0, steer: 0.1, analog: true, steerAngle: null };
    expect(k.input(inp, LIMIT + 1)).toEqual({ ...inp, throttle: 0 });
    expect(k.input(inp, LIMIT - 1)).toBe(inp);
    for (let t = 0; t < LIMITER_PENALTY_SECS + 0.1; t += DT) k.tick(DT, true, true);
    expect(k.serving).toBe(false);
    expect(k.input(inp, LIMIT + 1)).toBe(inp);
  });
});
