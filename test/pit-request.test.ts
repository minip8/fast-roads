// The pit request and its guidance (src/weekend.ts pitGuide / pitAdvice; raceHud.ts shows them), the assisted stop
// in the box, and when a drive-through is (and is not) told. Game Sessions in a room on the in-process relay
// (test/weekendRoom.ts).
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import { DT } from '../src/config';
import { pointAt } from '../src/track';
import type { DriveInput, Vehicle } from '../src/vehicle';
import type { PitGuide } from '../src/weekend';
import { type Client, Room } from './weekendRoom';

// A race under way at Melbourne (3 laps, one stop to make), our car on the autopilot after lights out.
async function race(car: 'lcf1' | 'lcgt3' | 'drift' = 'lcgt3') {
  const room = new Room();
  const a = await room.join('Ann', car, 'create');
  room.run(0.3);
  a.mp.net.setSettings({ practice: 0, qualifying: 'none', raceLaps: 3, pitStops: 1 });
  room.run(0.3);
  a.mp.net.startWeekend();
  room.until(() => a.mp.weekend.raceStage === 'racing', 12, 'lights out');
  room.run(1);
  return { room, a };
}

// The lane's middle (lat) at track position s, or the pit side of the road before the lane.
function laneTarget(c: Client, s: number) {
  const w = c.mp.weekend, L = w.lane, tr = c.s.track, ds = tr.L / tr.N;
  const d = ((s - L.sStart) % tr.L + tr.L) % tr.L;
  if (d > L.len) return L.side * ((L.side > 0 ? tr.WL : tr.WR)[pointAt(tr, s).i] - 1.6);   // before the lane: by the edge
  const k = Math.min(L.n - 1, Math.round(d / ds));
  return L.side * (L.inner[k] + L.outer[k]) / 2;
}

// Pure pursuit of a point Ld m ahead at the lateral position `want(s)` gives there (track lat): the autopilot's way.
function steerTo(c: Client) {
  return (want: (s: number) => number) => {
    const car = c.s.car, tr = c.s.track, Ld = Math.max(12, car.speedF * 0.8), s = car.proj.s + Ld;
    const tgt = pointAt(tr, s, want(s)), rx = tgt.x - car.pos.x, rz = tgt.z - car.pos.z;
    const a = Math.atan2(rx * car.left.x + rz * car.left.z, rx * car.fwd.x + rz * car.fwd.z), wb = car.spec.zFront - car.spec.zRear;
    return Math.atan((2 * wb * Math.sin(a)) / Ld);
  };
}

// What a player does from the guidance alone: the autopilot on the track until the pit entry is near, then into the
// lane's middle with the throttle down ("the limiter stops you"), nothing while serviced, out on "GO".
function guided(c: Client, seen: string[]) {
  const steer = steerTo(c);
  return (car: Vehicle): DriveInput => {
    const g: PitGuide | null = c.mp.weekend.pitGuide;
    if (g && seen[seen.length - 1] !== g.step) seen.push(g.step);
    const ap = autopilot(car, c.s.track);
    if (!g || (g.step === 'entry' && g.dist > 120)) return ap;   // (the last bend before the entry is the autopilot's)
    const out = g.step === 'go' && c.mp.weekend.pit.dist > c.mp.weekend.lane.limOut;
    // the pedals as on the track (the limiter does the rest in the lane), the wheel to the lane's middle
    return { ...ap, steerAngle: steer((s) => (out ? 0 : laneTarget(c, s))) };
  };
}

describe('the pit request', () => {
  test('a stop made from the guidance alone: entry, lane, box (the limiter stops the car), service, out', async () => {
    const { room, a } = await race();
    const w = a.mp.weekend;
    expect(w.pitHelp).toMatch(/pit lane on the (left|right)/);   // the first session of the weekend explains pit stops
    expect(w.pitGuide).toBeNull();
    // a stop owed: suggested with two laps to go (Melbourne's box is before the line: the last lap still has one)
    expect(w.boxPastLine).toBe(false);
    expect(w.pitAdvice).toBeNull();
    w.raceLaps = 1;
    expect(w.pitAdvice).toBe('1 stop owed');
    w.raceLaps = 0;
    // after the line: the request on, the guidance counts down to the entry
    expect(w.togglePitRequest()).toBe(true);
    const g0 = w.pitGuide;
    expect(g0).toMatchObject({ step: 'entry', side: w.lane.side });
    const steps: string[] = [];
    a.driver = guided(a, steps);
    // (straight to the last part of the lap: the car put on the track 400 m before the entry at a lane-approach speed)
    a.s.car.placeAt((w.lane.sStart - 400 + a.s.track.L) % a.s.track.L, 0, 30);
    room.until(() => w.pit.stopped, 60, 'the stop');
    room.until(() => !w.pit.inLane, 30, 'the pit exit');
    room.run(0.5);
    expect(steps).toEqual(['entry', 'lane', 'box', 'service', 'go']);
    expect(w.pit.stops).toBe(1);
    expect(w.pitRequest).toBe(false);
    expect(a.mp.takeNotices().some((n) => /Drive-through/.test(n.text))).toBe(false);
    expect(a.mp.net.standings.find((s) => s.player === a.mp.net.selfId)!.pits).toBe(1);
  }, 120_000);

  test('the assisted stop: flat out down the lane, the limiter stops the car in the box; on the brake key alone the window is short', async () => {
    const { room, a } = await race();
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, ds = tr.L / tr.N;
    // from the limit line at the limit: flat out (brakeAt null), or a brake key pressed fully brakeAt m before the box
    const run = (request: boolean, brakeAt: number | null) => {
      a.s.car.placeAt((L.sStart + L.len + 20) % tr.L, 0, 10);   // (out of the lane first: a new visit)
      room.run(0.2);
      const steer = steerTo(a);
      a.driver = () => {
        const toBox = L.box - w.pit.dist;
        const brake = brakeAt != null && w.pit.inLane && toBox < brakeAt ? 1 : 0;   // a key: all or nothing
        return { throttle: brake ? 0 : 1, brake, steer: 0, analog: true, steerAngle: steer((s) => laneTarget(a, s)), autoGears: true };
      };
      const k = Math.round(L.limIn / ds) + 10;
      a.s.car.placeAt((L.sStart + L.limIn + 10) % tr.L, L.side * (L.inner[k] + L.outer[k]) / 2, L.limitMs);
      room.run(DT * 2);
      if (!request) w.togglePitRequest();   // (driving in turned it on: off again)
      expect(w.pitRequest).toBe(request);
      let stopAt = null as number | null;
      room.until(() => {
        if (stopAt == null && Math.abs(a.s.car.speedF) < 0.5) stopAt = w.pit.dist - L.box;
        return w.pit.service > 0 || !w.pit.inLane || (stopAt != null && Math.abs(a.s.car.speedF) < 0.05);
      }, 30, 'a stop or the exit');
      const served = w.pit.service > 0;
      room.until(() => w.pit.service === 0, 10, 'the service');
      return { served, stopAt };
    };
    const assisted = run(true, null);
    expect(assisted.served).toBe(true);
    expect(Math.abs(assisted.stopAt!)).toBeLessThan(1);
    // the brake key alone at 80 km/h: only a short window of brake points stops the car in the 12 m box
    const keyed = [8, 12, 16, 20, 24, 28].map((at) => ({ at, ...run(false, at) }));
    console.log(`assisted: stopped ${assisted.stopAt!.toFixed(1)} m from the box's middle; brake key at ${keyed.map((r) => `${r.at} m: ${r.stopAt == null ? 'past' : r.stopAt.toFixed(1) + ' m'}${r.served ? ' (served)' : ''}`).join(', ')}`);
    const hits = keyed.filter((r) => r.served).length;
    expect(hits).toBeGreaterThan(0); expect(hits).toBeLessThan(keyed.length - 1);
  }, 120_000);

  test('a drive-through is told only for going past the box without stopping in a race still being run', async () => {
    const { room, a } = await race('drift');
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, ds = tr.L / tr.N;
    a.mp.takeNotices();
    const notices = () => a.mp.takeNotices().filter((n) => /Drive-through/.test(n.text)).length;
    // into the lane's zone and out again before the box (a brush with the lane): none
    const k = 15;
    a.s.car.placeAt((L.sStart + k * ds) % tr.L, L.side * (L.inner[k] + L.outer[k]) / 2, 20);
    room.run(DT * 3);
    expect(w.pit.inLane).toBe(true);
    expect(w.pitRequest).toBe(true);   // driving in asks for a stop
    a.s.car.placeAt((L.sStart + k * ds + 5) % tr.L, 0, 20);
    room.run(0.3);
    expect(w.pit.inLane).toBe(false);
    expect(notices()).toBe(0);
    // through the lane past the box with the request turned off: a drive-through
    const j = Math.round(L.box / ds) + 10;
    a.s.car.placeAt((L.sStart + L.box - 30) % tr.L, L.side * (L.inner[j] + L.outer[j]) / 2, L.limitMs);
    room.run(DT * 2);
    w.togglePitRequest();
    expect(w.pitRequest).toBe(false);
    a.driver = () => ({ throttle: 0.5, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true });
    room.until(() => w.pit.passedBox, 5, 'past the box');
    a.s.car.placeAt((a.s.car.proj.s + 5) % tr.L, 0, 20);
    room.run(0.3);
    expect(notices()).toBe(1);
    // the session over while the car is in the lane, then the next session: no drive-through for leaving it then
    a.driver = null;
    a.s.car.placeAt((L.sStart + L.box - 30) % tr.L, L.side * (L.inner[j] + L.outer[j]) / 2, 5);
    room.run(DT * 2);
    expect(w.pit.inLane).toBe(true);
    a.mp.net.skipSession();   // the host ends the race: results
    room.until(() => w.stage === 'results', 3, 'the results');
    room.run(1);
    expect(notices()).toBe(0);
  }, 120_000);
});
