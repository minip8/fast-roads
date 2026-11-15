import { describe, expect, it } from 'vitest';
import { CARS, type CarId } from '../src/cars';
import { DT } from '../src/config';
import { pointAt } from '../src/track';
import { TRACKS } from '../src/tracks';
import { session } from './harness';

// The game's start and its resets: the car is put on the straight before the line, already at flying-lap speed.
describe.each(Object.keys(CARS) as CarId[])('%s flying start', (id) => {
  it('starts before the line at its flying speed, in the gear for it, and holds the road', async () => {
    const { car, track, timing, drive } = await session(id, { flying: true });
    const def = TRACKS.melbourne, v = def.flying[id] / 3.6, spot = pointAt(track, track.L - def.startBack, 0);
    expect(Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z)).toBeLessThan(0.05);
    expect(car.speedF).toBeCloseTo(v, 1);
    expect(car.gear).toBeGreaterThan(3);
    expect(car.rpm).toBeGreaterThan(car.spec.idle * 1.5);
    expect(car.rpm).toBeLessThan(car.spec.redline * 1.05);   // the drift car runs just past its redline at top speed
    expect(car.prevPos.equals(car.pos)).toBe(true);
    expect(timing.lapStart).toBeNull();
    // flat out to the line: no wobble, no lost speed, and the lap starts there
    let lat = 0, slowest = Infinity;
    drive(4, () => ({ throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true }), () => {
      lat = Math.max(lat, Math.abs(car.proj.lat)); slowest = Math.min(slowest, car.speedF);
      return timing.lapStart != null;
    });
    expect(timing.lapStart).not.toBeNull();
    expect(timing.lapStart!).toBeLessThan(def.startBack / v + 0.1);
    expect(lat).toBeLessThan(0.3);
    expect(slowest).toBeGreaterThan(v - 1);
    expect(timing.valid).toBe(true);
  });

  it('a restart mid-lap goes back there and drops the lap', async () => {
    const { car, track, timing, drive, session: s } = await session(id, { flying: true });
    const def = TRACKS.melbourne, spot = pointAt(track, track.L - def.startBack, 0);
    car.manual = true;                        // the gear is set for the speed with either gearbox
    drive(6);                                 // over the line and into the lap
    expect(timing.lapStart).not.toBeNull();
    expect(Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z)).toBeGreaterThan(100);
    s.restart();
    expect(Math.hypot(car.pos.x - spot.x, car.pos.z - spot.z)).toBeLessThan(0.05);
    expect(car.speedF).toBeCloseTo(def.flying[id] / 3.6, 1);
    expect(car.gear).toBeGreaterThan(3);
    expect([timing.lapStart, timing.laps.length]).toEqual([null, 0]);
    drive(def.startBack / car.speedF + 0.5);  // the next lap starts at the line, clean
    expect(timing.lapStart).not.toBeNull();
    expect([timing.valid, timing.laps.length]).toEqual([true, 0]);
    expect(timing.lapStart!).toBeGreaterThan(6 + DT);
  });
});
