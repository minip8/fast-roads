// The pit lane's rules in the car (src/weekend.ts) on each circuit's real lane, and the pit request's guidance
// (pitGuide / pitAdvice; raceHud.ts shows them): a car in the lane can always drive on, the limiter only cuts the
// throttle, the driver brakes for the limit line and stops in the box by hand, speeding costs strikes and the stop,
// overshooting the box costs the stop, the autopilot pits by itself from racing speed, a lap through the pits counts
// once and is timed, the walls keep the lane and the track apart, and when a drive-through is (and is not) told.
// Game Sessions in a room on the in-process relay (test/weekendRoom.ts).
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import type { CarId } from '../src/cars';
import { DT } from '../src/config';
import { lanePoint, laneValue } from '../src/pitLane';
import { lanePlacement, PIT } from '../src/raceGeometry';
import { inPitLane, pointAt } from '../src/track';
import type { TrackId } from '../src/tracks';
import type { DriveInput, Vehicle } from '../src/vehicle';
import type { PitGuide } from '../src/weekend';
import { type Client, Room } from './weekendRoom';

// A race under way (3 laps, one stop to make), our car on the autopilot after lights out.
async function race(car: CarId = 'lcgt3', circuit: TrackId = 'melbourne') {
  const room = new Room({}, circuit);
  const a = await room.join('Ann', car, 'create');
  room.run(0.3);
  a.mp.net.setSettings({ practice: 0, qualifying: 'none', raceLaps: 3, pitStops: 1 });
  room.run(0.3);
  a.mp.net.startWeekend();
  room.until(() => a.mp.weekend.raceStage === 'racing', 12, 'lights out');
  room.run(1);
  return { room, a };
}

// The car put d m along the lane, `off` m from its path, rolling down it at v m/s.
function putInLane(c: Client, d: number, off: number, v: number) {
  const p = lanePlacement(c.s.track, c.mp.weekend.lane, d, off);
  c.s.car.placeAt(p.s, p.lat, v, p.heading);
}
// Out of the lane: on the track 40 m past its end.
function pastLane(c: Client, v: number) {
  const L = c.mp.weekend.lane;
  c.s.car.placeAt((laneValue(L, L.S, L.len) + 40) % c.s.track.L, 0, v);
}
// The autopilot's steering (along the lane in it; into it on its way to stop when `stop`).
const steering = (c: Client, stop = false) => autopilot(c.s.car, c.s.track, 0, stop ? { stop: true } : null).steerAngle;
const pedals = (throttle: number, brake = 0): DriveInput => ({ throttle, brake, steer: 0, analog: true, steerAngle: 0, autoGears: true });

// The pedals of a driver braking to be at `target` m/s `dist` m on, at `decel` m/s² (a firm, steady stop), with the
// throttle `free` until then. At the stop itself: no pedal once the car is at rest (a brake held at a standstill is
// the automatic box's reverse).
function pedalsTo(v: number, dist: number, target: number, decel: number, free: number) {
  const vt = Math.sqrt(target * target + 2 * decel * Math.max(0, dist));
  if (target === 0 && dist <= 0.3) return { throttle: 0, brake: Math.abs(v) > 0.3 ? 1 : 0 };
  if (v > vt + 0.3) return { throttle: 0, brake: Math.min(1, (v - vt) * 0.6 + 0.3) };
  return { throttle: v < vt - 1 ? free : 0, brake: 0 };
}

// What a player does from the guidance alone: the line into the lane and down it (the autopilot's steering on its way
// to stop), the pedals from the guidance: on the track as the autopilot, then braking from the BRAKE cue down to the
// limit by the limit line, letting the limiter hold it there, braking from the cue to a stop at the box's middle,
// nothing while serviced, out on GO.
function guided(c: Client, seen: string[]) {
  const w = c.mp.weekend, L = w.lane;
  let braking = false;
  return (car: Vehicle): DriveInput => {
    const g: PitGuide | null = w.pitGuide;
    if (g && seen[seen.length - 1] !== g.step) seen.push(g.step);
    const ap = autopilot(car, c.s.track), v = car.speedF, steerAngle = steering(c, !w.pit.stopped);
    if (!g || (g.step === 'entry' && g.dist > 150 && !g.brake)) return ap;
    if ((g.step === 'entry' || g.step === 'limit' || g.step === 'box') && g.brake) braking = true;
    if (g.step === 'entry' || g.step === 'limit') {
      const dist = g.step === 'entry' ? g.dist + L.limIn : g.dist;
      return { ...ap, ...(braking ? pedalsTo(v, dist - 3, L.limitMs - 1, 6, ap.throttle) : {}), steerAngle };
    }
    if (g.step === 'lane') { braking = false; return { ...ap, throttle: 1, brake: 0, steerAngle }; }
    if (g.step === 'box') return { ...ap, ...(braking ? pedalsTo(v, g.box, 0, 5, 1) : { throttle: 1, brake: 0 }), steerAngle };
    return { ...ap, throttle: 1, brake: 0, steerAngle };
  };
}

// The autopilot's plan's speed at lap position s (racing speed there).
function planSpeed(c: Client, s: number) {
  autopilot(c.s.car, c.s.track);   // (the plan, cached)
  const prof = c.s.track.speedProfiles?.[c.s.car.spec.id];
  return prof ? prof[pointAt(c.s.track, s).i] : 30;
}

describe('a car in the pit lane', () => {
  // The owner's report: driving into the lane after the pit area to stop left the car unable to move (the pit request,
  // turned on by driving in, had the limiter "stop the car in the box", whose speed cap was 0 once past it). Wherever
  // a car is in the lane, however it got there and whatever the request says, full throttle takes it on (at most a
  // service in the box holds it, for the service's seconds).
  test('can always drive on: put anywhere along the lane, at rest or rolling, with the request on or off', async () => {
    const { room, a } = await race();
    const w = a.mp.weekend, L = w.lane;
    const stuck: string[] = [];
    for (let d = 5; d < L.len - 5; d += 25) for (const v of [0, 12]) for (const request of [true, false]) {
      pastLane(a, 10);   // (out of the lane first: a new visit)
      a.driver = null;
      room.run(0.1);
      putInLane(a, d, 0, v);
      a.driver = () => ({ ...pedals(1), steerAngle: steering(a) });
      room.run(DT * 2);
      if (w.pitRequest !== request) w.togglePitRequest();
      const from = a.s.car.pos.clone();
      let moved = false;
      for (let t = 0; t < 15 && !moved; t += 0.25) {
        room.run(0.25);
        moved = Math.hypot(a.s.car.pos.x - from.x, a.s.car.pos.z - from.z) > 20;
      }
      if (!moved) stuck.push(`${d} m into the lane (box at ${L.box.toFixed(0)} m), ${v} m/s, request ${request ? 'on' : 'off'}`);
    }
    expect(stuck).toEqual([]);
  }, 300_000);

  test('the limiter only cuts the throttle: no braking on the way in, none in the box, the limit held under full throttle', async () => {
    const { room, a } = await race('drift');
    const w = a.mp.weekend, L = w.lane;
    let braked = 0, top = 0;
    a.driver = () => ({ ...pedals(0), steerAngle: steering(a) });   // coasting: nothing slows it but drag
    putInLane(a, L.nose + 5, 0, 30);
    room.run(DT);
    const orig = w.input.bind(w);
    w.input = (inp, at, parked) => { const r = orig(inp, at, parked); if (r.brake > 0) braked++; return r; };
    room.until(() => (w.pit.inLane && w.pit.dist > L.box + 20) || Math.abs(a.s.car.speedF) < 0.5, 60, 'past the box, or rolled to a stop');
    expect(braked).toBe(0);
    // flat out from the limit line at the limit: held just under it
    putInLane(a, L.limIn + 6, 0, L.limitMs - 2);
    a.driver = () => ({ ...pedals(1), steerAngle: steering(a) });
    room.run(DT);
    room.until(() => { if (w.pit.inLane && w.pit.dist < L.limOut) top = Math.max(top, a.s.car.speedF); return w.pit.dist > L.limOut; }, 60, 'the second limit line');
    expect(braked).toBe(0);
    expect(top * 3.6).toBeGreaterThan(PIT.limitKmh - 3);
    expect(top * 3.6).toBeLessThan(PIT.limitKmh + 1);
  }, 120_000);

  test('the walls: no way from the track into the lane, or back, but at the openings', async () => {
    const { room, a } = await race('lcgt3');
    const w = a.mp.weekend, L = w.lane, tr = a.s.track;
    // from the track's middle at 30 m/s, turned 60 deg towards the lane at points along the pit wall: still on the track
    let through = 0;
    for (let d = L.nose + 40; d < L.tail - 40; d += 60) {
      const i = L.I[Math.round(d / 2)];
      a.s.car.placeAt(tr.S[i], 0, 30, L.side * Math.PI / 3);
      a.driver = () => pedals(1);
      room.run(1.5);
      if (inPitLane(tr, a.s.car.pos.x, a.s.car.pos.z)) through++;
    }
    expect(through).toBe(0);
    // and from the lane by the box, turned 60 deg towards the track: still in the lane
    const p = lanePlacement(tr, L, L.box - 20, 0);
    a.s.car.placeAt(p.s, p.lat, 25, p.heading - L.side * Math.PI / 3);
    room.run(1.5);
    expect(inPitLane(tr, a.s.car.pos.x, a.s.car.pos.z)).toBe(true);
    void lanePoint;
  }, 120_000);
});

describe('the pit request', () => {
  test('a stop made from the guidance alone: entry, limit line, lane, box (braked by the driver), service, out', async () => {
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
    expect(g0).toMatchObject({ step: 'entry', side: w.lane.side, brake: false });
    const steps: string[] = [];
    a.driver = guided(a, steps);
    // (straight to the last part of the lap: the car put on the track 500 m before the lane at racing speed)
    const tr = a.s.track, s0 = (w.lane.sStart - 500 + tr.L) % tr.L;
    a.s.car.placeAt(s0, 0, 0.9 * planSpeed(a, s0));
    let cue = false;
    room.until(() => { const g = w.pitGuide; if (g && 'brake' in g && g.brake) cue = true; return w.pit.stopped; }, 90, 'the stop');
    room.until(() => !w.pit.inLane, 60, 'the pit exit');
    room.run(0.5);
    expect(cue).toBe(true);   // (the BRAKE cue came up on the way in)
    expect(steps).toEqual(['entry', 'limit', 'lane', 'box', 'service', 'go']);
    expect(w.pit.stops).toBe(1);
    expect(w.strikes.count).toBe(0);
    expect(w.pitRequest).toBe(false);
    expect(a.mp.takeNotices().some((n) => /Drive-through|SPEEDING/.test(n.text))).toBe(false);
    expect(a.mp.net.standings.find((s) => s.player === a.mp.net.selfId)!.pits).toBe(1);
  }, 180_000);

  test('stopping by hand: a steady stop lands in the box; on the brake key the window is fair; overshooting costs the stop, not the car', async () => {
    const { room, a } = await race();
    const w = a.mp.weekend, L = w.lane;
    // from the limit line at the limit: `pedal` from the box's distance
    const run = (pedal: (toBox: number, v: number) => { throttle: number; brake: number }) => {
      pastLane(a, 10);   // (out of the lane first: a new visit)
      room.run(0.2);
      a.driver = (car) => ({ ...pedals(0), steerAngle: steering(a, true), ...pedal(L.box - w.pit.dist, car.speedF) });
      putInLane(a, L.limIn + 10, 0, L.limitMs - 0.5);
      room.run(DT * 2);
      let stopAt = null as number | null;
      room.until(() => {
        if (stopAt == null && Math.abs(a.s.car.speedF) < 0.5) stopAt = w.pit.dist - L.box;
        return w.pit.service > 0 || !w.pit.inLane || (stopAt != null && Math.abs(a.s.car.speedF) < 0.05);
      }, 60, 'a stop or the exit');
      const served = w.pit.service > 0;
      room.until(() => w.pit.service === 0, 10, 'the service');
      return { served, stopAt };
    };
    // a driver braking steadily at 5 m/s² for the box's middle
    const steady = run((toBox, v) => pedalsTo(v, toBox, 0, 5, 1));
    expect(steady.served).toBe(true);
    expect(Math.abs(steady.stopAt!)).toBeLessThan(1.5);
    // the brake key pressed fully at 80 km/h some distance before the box's middle: a window of several metres works
    const keyed = [8, 12, 16, 20, 24, 28, 32].map((at) => ({ at, ...run((toBox, v) => (toBox < at ? { throttle: 0, brake: Math.abs(v) > 0.3 ? 1 : 0 } : { throttle: 1, brake: 0 })) }));
    console.log(`steady: stopped ${steady.stopAt!.toFixed(1)} m from the box's middle; brake key at ${keyed.map((r) => `${r.at} m: ${r.stopAt == null ? 'past' : r.stopAt.toFixed(1) + ' m'}${r.served ? ' (served)' : ''}`).join(', ')}`);
    const hits = keyed.filter((r) => r.served);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.length).toBeLessThan(keyed.length);
    // braked too late: past the box, no service, and the car drives on from where it stopped
    a.mp.takeNotices();
    const stops = w.pit.stops;
    const late = run((toBox, v) => (toBox < 2 ? { throttle: 0, brake: Math.abs(v) > 0.3 ? 1 : 0 } : { throttle: 1, brake: 0 }));
    expect(late.served).toBe(false);
    expect(w.pit.passedBox).toBe(true);
    expect(w.pitGuide).toEqual({ step: 'missed', why: 'past' });
    a.driver = () => ({ ...pedals(1), steerAngle: steering(a) });
    room.until(() => !w.pit.inLane, 60, 'the pit exit');
    expect(w.pit.stops).toBe(stops);
    expect(a.mp.takeNotices().some((n) => /Drive-through/.test(n.text))).toBe(true);
  }, 240_000);

  test('speeding in the lane: a strike at the limit line and every second over it, and no service', async () => {
    const { room, a } = await race('drift');
    const w = a.mp.weekend, L = w.lane;
    a.mp.takeNotices();
    // over the limit line at 120 km/h, coasting, then braking gently for the box
    putInLane(a, L.limIn - 10, 0, 120 / 3.6);
    a.driver = (car) => ({ ...pedals(0), steerAngle: steering(a, true), ...pedalsTo(car.speedF, L.box - w.pit.dist, 0, 2, 0) });
    room.run(DT);
    room.until(() => w.pit.inLane && w.pit.dist > L.limIn, 5, 'the limit line');
    room.run(DT * 2);
    expect(w.pit.sped).toBe(true);
    expect(w.strikes.count + (w.strikes.pending ? 3 : 0)).toBeGreaterThanOrEqual(1);
    room.until(() => Math.abs(a.s.car.speedF) < 0.05 || w.pit.passedBox, 60, 'a stop');
    room.run(0.5);
    expect(w.pit.service).toBe(0);
    expect(w.pit.stops).toBe(0);
    expect(w.pitGuide).toEqual({ step: 'missed', why: 'speeding' });
    const flags = a.mp.takeNotices().filter((n) => n.kind === 'flag').map((n) => n.text);
    expect(flags[0]).toBe('PIT LANE SPEEDING 1/3');
    // (over the limit for some seconds: a strike each second)
    expect(flags.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test('a drive-through is told only for going past the box without stopping in a race still being run', async () => {
    const { room, a } = await race('drift');
    const w = a.mp.weekend, L = w.lane;
    a.mp.takeNotices();
    const notices = () => a.mp.takeNotices().filter((n) => /Drive-through/.test(n.text)).length;
    // into the lane before the box: a stop is asked for; out again (put back on the track) before the box: none
    putInLane(a, L.nose + 10, 0, 20);
    room.run(DT * 3);
    expect(w.pit.inLane).toBe(true);
    expect(w.pitRequest).toBe(true);   // driving in asks for a stop
    pastLane(a, 20);
    room.run(0.3);
    expect(w.pit.inLane).toBe(false);
    expect(notices()).toBe(0);
    // through the lane past the box with the request turned off: a drive-through
    putInLane(a, L.box - 30, 0, L.limitMs - 1);
    room.run(DT * 2);
    w.togglePitRequest();
    expect(w.pitRequest).toBe(false);
    a.driver = () => ({ ...pedals(0.5), steerAngle: steering(a) });
    room.until(() => w.pit.passedBox, 10, 'past the box');
    pastLane(a, 20);
    room.run(0.3);
    expect(notices()).toBe(1);
    // into the lane after the box: no request, nothing to stop for
    putInLane(a, L.box + 30, 0, 15);
    room.run(DT * 3);
    expect(w.pit.inLane).toBe(true);
    expect(w.pitRequest).toBe(false);
    // the session over while the car is in the lane, then the next session: no drive-through for leaving it then
    a.driver = () => ({ ...pedals(0, 1), steerAngle: steering(a) });
    putInLane(a, L.box - 30, 0, 5);
    room.run(DT * 2);
    expect(w.pit.inLane).toBe(true);
    a.mp.net.skipSession();   // the host ends the race: results
    room.until(() => w.stage === 'results', 3, 'the results');
    room.run(1);
    expect(notices()).toBe(0);
  }, 120_000);
});

describe('pitting at every kind of circuit', () => {
  // The autopilot pits by itself from racing speed (its pit plan: Weekend.pitPlan while the request is on), braking for
  // the limit line and stopping in the box with no help from the game; the lap through the pits is timed and counted
  // once, valid in a race; then it rejoins and laps on. A permanent circuit's lane beside the straight (Melbourne), one
  // cutting far inside two corners (Silverstone), a street circuit's (Monaco), a long exit road (São Paulo).
  test.each([['melbourne', 'lcgt3'], ['silverstone', 'lcf1'], ['monaco', 'lcgt3'], ['saopaulo', 'drift']] as [TrackId, CarId][])('%s, %s', async (circuit, car) => {
    const { room, a } = await race(car, circuit);
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, t = a.s.timing;
    a.mp.takeNotices();
    a.driver = null;   // (the room's default: the autopilot with the weekend's pit plan)
    // from racing speed on the track, 700 m before the lane
    const s0 = (L.sStart - 700 + tr.L) % tr.L;
    a.s.car.placeAt(s0, 0, planSpeed(a, s0));
    room.run(DT);
    const laps = t.laps.length;
    w.setPitRequest(true);
    let top = 0;
    room.until(() => { if (w.pit.inLane && w.pit.dist > L.limIn + 1 && w.pit.dist < L.limOut) top = Math.max(top, a.s.car.speedF); return w.pit.stopped; }, 120, 'the stop');
    expect(w.pit.stops).toBe(1);
    expect(w.pit.sped).toBe(false);
    expect(w.strikes.count).toBe(0);
    expect(top * 3.6).toBeLessThan(PIT.limitKmh + PIT.speedTolKmh);
    // out of the lane and on round to the line: the lap through the pits ends once, timed, valid in a race
    room.until(() => !w.pit.inLane, 120, 'the pit exit');
    room.until(() => t.laps.length > laps, 240, 'the lap through the pits');
    room.run(1);
    expect(t.laps.length).toBe(laps + 1);
    expect(t.laps[0].valid).toBe(true);
    expect(t.laps[0].time).toBeGreaterThan(20);
    expect(a.mp.takeNotices().some((n) => /Drive-through|SPEEDING/.test(n.text))).toBe(false);
    expect(a.mp.net.standings.find((s) => s.player === a.mp.net.selfId)!.pits).toBe(1);
  }, 300_000);
});
