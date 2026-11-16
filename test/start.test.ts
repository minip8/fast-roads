import { describe, expect, it } from 'vitest';
import { autopilot } from '../src/autopilot';
import { CARS, type CarId } from '../src/cars';
import { DT } from '../src/config';
import { Timing } from '../src/timing';
import { pointAt } from '../src/track';
import { TRACKS } from '../src/tracks';
import type { Vehicle } from '../src/vehicle';
import { session, trackFor } from './harness';

// The game's start and its resets: the car is put on the straight before the last corners (at Albert Park, before
// turns 13 and 14), already at flying-lap speed, and drives them to the line, where the lap starts.
describe.each(Object.keys(CARS) as CarId[])('%s flying start', (id) => {
  it('starts before the last corners at its flying speed, in the gear for it, and takes them onto the lap', async () => {
    const { car, track, timing, drive, session: s } = await session(id, { flying: true });
    const def = TRACKS.melbourne, v = def.flying[id] / 3.6, spot = pointAt(track, track.L - def.startBack, 0);
    expect(Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z)).toBeLessThan(0.05);
    expect(car.fwd.x * track.TX[spot.i] + car.fwd.z * track.TZ[spot.i]).toBeGreaterThan(0.9999);
    expect(car.speedF).toBeCloseTo(v, 1);
    expect(car.gear).toBeGreaterThan(0);
    expect(car.rpm).toBeGreaterThan(car.spec.idle * 1.5);
    expect(car.rpm).toBeLessThan(car.spec.redline * 1.05);
    expect(car.prevPos.equals(car.pos)).toBe(true);
    expect(timing.lapStart).toBeNull();
    // the autopilot through the last corners: on the road all the way, and the lap starts at the line, clean
    let out = 0, wide = 0;
    drive(30, null, () => {
      if (car.wheels.some((w) => w.out)) out++;
      wide = Math.max(wide, Math.abs(car.proj.lat));
      return timing.lapStart != null;
    });
    expect(timing.lapStart).not.toBeNull();
    expect(timing.lapStart!).toBeGreaterThan(8);              // the run-up: about 11-14 s here
    expect(timing.lapStart!).toBeLessThan(16);
    expect(s.simTime - timing.lapStart!).toBeLessThan(DT);
    expect(out).toBe(0);
    expect(wide).toBeLessThan(4);
    expect([timing.valid, timing.nextInvalid]).toEqual([true, '']);
  });

  it('a restart mid-lap goes back there and drops the lap', async () => {
    const { car, track, timing, drive, session: s } = await session(id, { flying: true });
    const def = TRACKS.melbourne, spot = pointAt(track, track.L - def.startBack, 0);
    car.manual = true;                        // the gear is set for the speed with either gearbox
    drive(20, null, () => timing.lapStart != null && s.simTime > timing.lapStart + 3);   // over the line and into the lap
    expect(timing.lapStart).not.toBeNull();
    expect(Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z)).toBeGreaterThan(300);
    const restartAt = s.simTime;
    s.restart();
    expect(Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z)).toBeLessThan(0.05);
    expect(car.speedF).toBeCloseTo(def.flying[id] / 3.6, 1);
    expect(car.gear).toBeGreaterThan(0);
    expect([timing.lapStart, timing.laps.length]).toEqual([null, 0]);
    drive(30, null, () => timing.lapStart != null);   // the next lap starts at the line, clean
    expect(timing.lapStart).not.toBeNull();
    expect([timing.valid, timing.laps.length]).toEqual([true, 0]);
    expect(timing.lapStart!).toBeGreaterThan(restartAt + 8);
  });
});

describe('track limits in the run-up', () => {
  it('going off before the line deletes the lap that starts there; a restart forgives it', async () => {
    const { car, track, timing, drive, session: s } = await session('lcgt3', { flying: true });
    timing.events.length = 0;
    // wide of the road on the left for a moment, then back on it
    drive(3, (c) => autopilot(c, track, track.WL[c.proj.i] + 4), () => car.wheels.every((w) => w.out));
    expect(car.wheels.every((w) => w.out)).toBe(true);
    expect(timing.nextInvalid).toBe('TRACK LIMITS');
    expect(timing.events).toEqual([{ type: 'invalid', reason: 'TRACK LIMITS', laps: 'next' }]);
    drive(30, null, () => timing.lapStart != null);
    expect(timing.lapStart).not.toBeNull();
    expect([timing.valid, timing.invalidReason, timing.nextInvalid]).toEqual([false, 'TRACK LIMITS', '']);
    s.restart();
    expect([timing.lapStart, timing.nextInvalid]).toEqual([null, '']);
    drive(30, null, () => timing.lapStart != null);
    expect(timing.valid).toBe(true);
  });

  it('at the end of a lap deletes it and the next; earlier in the lap only the lap under way', async () => {
    const track = await trackFor('melbourne'), def = TRACKS.melbourne;
    const off = (s: number) => {
      const p = pointAt(track, s, track.WL[pointAt(track, s).i] + 5);
      return { wheels: [0, 1, 2, 3].map(() => ({ out: true })), proj: { s, i: p.i, lat: 5 }, pos: p } as unknown as Vehicle;
    };
    const t = new Timing(track, 'test.runup', def.startBack);
    const lapOn = (next: number) => { t.reset(); t.lapStart = 0; t.next = next; t.events.length = 0; };
    lapOn(2);                                             // the middle sector: not the run-up
    let car = off(track.L * 0.5);
    t.tick(car.pos, car.pos, 10, DT, car);
    expect([t.valid, t.nextInvalid, t.events]).toEqual([false, '', [{ type: 'invalid', reason: 'TRACK LIMITS', laps: 'this' }]]);
    lapOn(0);                                             // the last sector, in the run-up
    car = off(track.L - def.startBack / 2);
    t.tick(car.pos, car.pos, 10, DT, car);
    expect([t.valid, t.nextInvalid, t.events]).toEqual([false, 'TRACK LIMITS', [{ type: 'invalid', reason: 'TRACK LIMITS', laps: 'both' }]]);
    t.tick(car.pos, car.pos, 10 + DT, DT, car);           // once
    expect(t.events).toHaveLength(1);
    lapOn(0);                                             // the last sector, before the run-up
    car = off(track.L - def.startBack - 50);
    t.tick(car.pos, car.pos, 10, DT, car);
    expect([t.valid, t.nextInvalid]).toEqual([false, '']);
  });
});
