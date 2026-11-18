// The pit lane's rules in the car (src/weekend.ts) and the pit request's guidance (pitGuide / pitAdvice; raceHud.ts
// shows them): a car in the lane can always drive on, the limiter only cuts the throttle, the driver brakes for the
// limit line and stops in the box by hand, speeding costs strikes and the stop, overshooting the box costs the stop,
// and when a drive-through is (and is not) told. Game Sessions in a room on the in-process relay (test/weekendRoom.ts).
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import { DT } from '../src/config';
import { PIT } from '../src/raceGeometry';
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

// The pedals of a driver braking to be at `target` m/s `dist` m on, at `decel` m/s² (a firm, steady stop), with the
// throttle `free` until then. At the stop itself: no pedal once the car is at rest (a brake held at a standstill is
// the automatic box's reverse).
function pedalsTo(v: number, dist: number, target: number, decel: number, free: number) {
  const vt = Math.sqrt(target * target + 2 * decel * Math.max(0, dist));
  if (target === 0 && dist <= 0.3) return { throttle: 0, brake: Math.abs(v) > 0.3 ? 1 : 0 };
  if (v > vt + 0.3) return { throttle: 0, brake: Math.min(1, (v - vt) * 0.6 + 0.3) };
  return { throttle: v < vt - 1 ? free : 0, brake: 0 };
}

// What a player does from the guidance alone: the autopilot on the track until the pit entry is near, then the pit
// side of the road and the lane's middle; brakes from the BRAKE cue down to the limit by the limit line, lets the
// limiter hold it there, brakes from the cue to a stop at the box's middle, nothing while serviced, out on GO.
function guided(c: Client, seen: string[]) {
  const steer = steerTo(c), w = c.mp.weekend, L = w.lane;
  let braking = false;
  return (car: Vehicle): DriveInput => {
    const g: PitGuide | null = w.pitGuide;
    if (g && seen[seen.length - 1] !== g.step) seen.push(g.step);
    const ap = autopilot(car, c.s.track), v = car.speedF;
    if (!g || (g.step === 'entry' && g.dist > 120 && !g.brake)) return ap;   // (the last bend before the entry is the autopilot's)
    const out = (g.step === 'go' || g.step === 'missed') && w.pit.dist > L.limOut;
    const steerAngle = steer((s) => (out ? 0 : laneTarget(c, s)));
    if ((g.step === 'entry' || g.step === 'limit' || g.step === 'box') && g.brake) braking = true;
    if (g.step === 'entry' || g.step === 'limit') {
      const dist = g.step === 'entry' ? g.dist + L.limIn : g.dist;
      return { ...ap, ...(braking ? pedalsTo(v, dist - 3, L.limitMs - 1, 6, ap.throttle) : {}), steerAngle };
    }
    if (g.step === 'lane') { braking = false; return { ...ap, throttle: 1, brake: 0, steerAngle }; }
    if (g.step === 'box') return { ...ap, ...(braking ? pedalsTo(v, g.box, 0, 5, 1) : { throttle: 1, brake: 0 }), steerAngle };
    return { ...ap, steerAngle };
  };
}

const flat = (steer: number | null): DriveInput => ({ throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: steer, autoGears: true });

describe('a car in the pit lane', () => {
  // The owner's report: driving into the lane after the pit area to stop left the car unable to move (the pit request,
  // turned on by driving in, had the limiter "stop the car in the box", whose speed cap was 0 once past it). Wherever
  // a car is in the lane, however it got there and whatever the request says, full throttle takes it on (at most a
  // service in the box holds it, for the service's seconds).
  test('can always drive on: put anywhere along the lane, at rest or rolling, with the request on or off', async () => {
    const { room, a } = await race();
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, ds = tr.L / tr.N;
    const stuck: string[] = [];
    for (let d = 5; d < L.len - 5; d += 25) for (const v of [0, 12]) for (const request of [true, false]) {
      a.s.car.placeAt((L.sStart + L.len + 40) % tr.L, 0, 10);   // (out of the lane first: a new visit)
      a.driver = null;
      room.run(0.1);
      const k = Math.min(L.n - 1, Math.round(d / ds));
      a.s.car.placeAt((L.sStart + d) % tr.L, L.side * (L.inner[k] + L.outer[k]) / 2, v);
      const steer = steerTo(a);
      a.driver = () => flat(steer((s) => laneTarget(a, s)));
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
  }, 240_000);

  test('the limiter only cuts the throttle: no braking on the way in, none in the box, the limit held under full throttle', async () => {
    const { room, a } = await race('drift');
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, ds = tr.L / tr.N;
    let braked = 0, top = 0;
    const steer = steerTo(a);
    a.driver = () => ({ ...flat(steer((s) => laneTarget(a, s))), throttle: 0 });   // coasting: nothing slows it but drag
    const k = 5;
    a.s.car.placeAt((L.sStart + k * ds) % tr.L, L.side * (L.inner[k] + L.outer[k]) / 2, 30);
    room.run(DT);
    const orig = a.mp.weekend.input.bind(a.mp.weekend);
    a.mp.weekend.input = (inp, at, parked) => { const r = orig(inp, at, parked); if (r.brake > 0) braked++; return r; };
    room.until(() => w.pit.dist > L.box + 20, 30, 'past the box');
    expect(braked).toBe(0);
    // flat out from the limit line at the limit: held just under it
    const j = Math.round(L.limIn / ds) + 3;
    a.s.car.placeAt((L.sStart + j * ds) % tr.L, L.side * (L.inner[j] + L.outer[j]) / 2, L.limitMs - 2);
    a.driver = () => flat(steer((s) => laneTarget(a, s)));
    room.run(DT);
    room.until(() => { if (w.pit.inLane && w.pit.dist < L.limOut) top = Math.max(top, a.s.car.speedF); return w.pit.dist > L.limOut; }, 30, 'the second limit line');
    expect(braked).toBe(0);
    expect(top * 3.6).toBeGreaterThan(PIT.limitKmh - 3);
    expect(top * 3.6).toBeLessThan(PIT.limitKmh + 1);
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
    // (straight to the last part of the lap: the car put on the track 400 m before the entry at a lane-approach speed)
    a.s.car.placeAt((w.lane.sStart - 400 + a.s.track.L) % a.s.track.L, 0, 30);
    let cue = false;
    room.until(() => { const g = w.pitGuide; if (g && 'brake' in g && g.brake) cue = true; return w.pit.stopped; }, 60, 'the stop');
    room.until(() => !w.pit.inLane, 30, 'the pit exit');
    room.run(0.5);
    expect(cue).toBe(true);   // (the BRAKE cue came up on the way in)
    expect(steps).toEqual(['entry', 'limit', 'lane', 'box', 'service', 'go']);
    expect(w.pit.stops).toBe(1);
    expect(w.strikes.count).toBe(0);
    expect(w.pitRequest).toBe(false);
    expect(a.mp.takeNotices().some((n) => /Drive-through|SPEEDING/.test(n.text))).toBe(false);
    expect(a.mp.net.standings.find((s) => s.player === a.mp.net.selfId)!.pits).toBe(1);
  }, 120_000);

  test('stopping by hand: a steady stop lands in the box; on the brake key the window is fair; overshooting costs the stop, not the car', async () => {
    const { room, a } = await race();
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, ds = tr.L / tr.N;
    const steer = steerTo(a);
    // from the limit line at the limit: `pedals` from the box's distance
    const run = (pedals: (toBox: number, v: number) => { throttle: number; brake: number }) => {
      a.s.car.placeAt((L.sStart + L.len + 20) % tr.L, 0, 10);   // (out of the lane first: a new visit)
      room.run(0.2);
      a.driver = (car) => ({ ...flat(steer((s) => laneTarget(a, s))), ...pedals(L.box - w.pit.dist, car.speedF) });
      const k = Math.round(L.limIn / ds) + 10;
      a.s.car.placeAt((L.sStart + L.limIn + 10) % tr.L, L.side * (L.inner[k] + L.outer[k]) / 2, L.limitMs - 0.5);
      room.run(DT * 2);
      let stopAt = null as number | null;
      room.until(() => {
        if (stopAt == null && Math.abs(a.s.car.speedF) < 0.5) stopAt = w.pit.dist - L.box;
        return w.pit.service > 0 || !w.pit.inLane || (stopAt != null && Math.abs(a.s.car.speedF) < 0.05);
      }, 30, 'a stop or the exit');
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
    a.driver = () => flat(steer((s) => laneTarget(a, s)));
    room.until(() => !w.pit.inLane, 20, 'the pit exit');
    expect(w.pit.stops).toBe(stops);
    expect(a.mp.takeNotices().some((n) => /Drive-through/.test(n.text))).toBe(true);
  }, 180_000);

  test('speeding in the lane: a strike at the limit line and every second over it, and no service', async () => {
    const { room, a } = await race('drift');
    const w = a.mp.weekend, L = w.lane, tr = a.s.track, ds = tr.L / tr.N;
    const steer = steerTo(a);
    a.mp.takeNotices();
    // over the limit line at 120 km/h, coasting, then braking hard for the box
    const k = Math.round(L.limIn / ds) - 5;
    a.s.car.placeAt((L.sStart + k * ds) % tr.L, L.side * (L.inner[k] + L.outer[k]) / 2, 120 / 3.6);
    a.driver = (car) => ({ ...flat(steer((s) => laneTarget(a, s))), ...pedalsTo(car.speedF, L.box - w.pit.dist, 0, 3, 0) });
    room.run(DT);
    room.until(() => w.pit.inLane && w.pit.dist > L.limIn, 5, 'the limit line');
    room.run(DT * 2);
    expect(w.pit.sped).toBe(true);
    expect(w.strikes.count + (w.strikes.pending ? 3 : 0)).toBeGreaterThanOrEqual(1);
    room.until(() => Math.abs(a.s.car.speedF) < 0.05 || w.pit.passedBox, 30, 'a stop');
    room.run(0.5);
    expect(w.pit.service).toBe(0);
    expect(w.pit.stops).toBe(0);
    expect(w.pitGuide).toEqual({ step: 'missed', why: 'speeding' });
    const flags = a.mp.takeNotices().filter((n) => n.kind === 'flag').map((n) => n.text);
    expect(flags[0]).toBe('PIT LANE SPEEDING 1/3');
    // (over the limit for several seconds: a strike each second, three of them the limiter penalty)
    expect(flags.length).toBeGreaterThanOrEqual(2);
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
    a.s.car.placeAt((L.sStart + L.box - 30) % tr.L, L.side * (L.inner[j] + L.outer[j]) / 2, L.limitMs - 1);
    room.run(DT * 2);
    w.togglePitRequest();
    expect(w.pitRequest).toBe(false);
    a.driver = () => ({ throttle: 0.5, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true });
    room.until(() => w.pit.passedBox, 5, 'past the box');
    a.s.car.placeAt((a.s.car.proj.s + 5) % tr.L, 0, 20);
    room.run(0.3);
    expect(notices()).toBe(1);
    // into the lane after the box: no request, nothing to stop for
    const m = Math.round((L.box + 30) / ds);
    a.s.car.placeAt((L.sStart + m * ds) % tr.L, L.side * (L.inner[m] + L.outer[m]) / 2, 15);
    room.run(DT * 3);
    expect(w.pit.inLane).toBe(true);
    expect(w.pitRequest).toBe(false);
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
