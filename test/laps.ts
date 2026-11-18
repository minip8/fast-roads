import { pitFootprint } from '../src/pitLane';
import { laneWalls, type Track } from '../src/track';
import { expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import { TRACKS, type TrackId } from '../src/tracks';
import { session } from './harness';

// Autopilot lap times from the game's flying start, pinned to the millisecond. The simulation is deterministic, so
// they only change when physics or car tuning changes (or the start: TrackDef.startBack and .flying, before the last
// corners: the drift car's laps come out the same as a lap after a lap, to a few ms; the LibreCorsa cars' depend on
// what the run-up leaves them: tyres placed at the heat of a lap, and the F1's battery, which a restart fills). If you changed handling on purpose, check the car still behaves, then update them here.
// Each lap has its own test file (laps-*.test.ts), so Vitest runs them in parallel.
const EXPECTED = {
  drift: { track: 'melbourne', car: 'drift', tc: true, time: '157.515', limit: 200 },
  driftNoTc: { track: 'melbourne', car: 'drift', tc: false, time: '157.492', limit: 200 },
  silverstoneDrift: { track: 'silverstone', car: 'drift', tc: true, time: '169.789', limit: 220 },
  // on LibreCorsa's engine (src/lc)
  lcGt3: { track: 'melbourne', car: 'lcgt3', tc: true, time: '133.860', limit: 170 },
  silverstoneLcGt3: { track: 'silverstone', car: 'lcgt3', tc: true, time: '144.184', limit: 190 },
  lcF1: { track: 'melbourne', car: 'lcf1', tc: true, time: '116.548', limit: 150 },
  silverstoneLcF1: { track: 'silverstone', car: 'lcf1', tc: true, time: '123.931', limit: 160 },
} satisfies Record<string, { track: TrackId; car: CarId; tc: boolean; time: string; limit: number }>;

export function lapTest(lap: keyof typeof EXPECTED) {
  const { track, car, tc, time, limit } = EXPECTED[lap];
  it(`${car} laps ${track} cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, () => lapCheck(track, car, tc, time, limit));
}

// The rest of the calendar, TC on: run by npm run test:laps (test/calendar/<circuit>.test.ts, one file per circuit).
type Times = Record<CarId, string>;
const CALENDAR: Record<Exclude<TrackId, 'melbourne' | 'silverstone'>, Times> = {
  shanghai: { lcf1: '120.174', lcgt3: '139.149', drift: '165.784' },
  suzuka: { lcf1: '118.488', lcgt3: '137.825', drift: '167.861' },
  miami: { lcf1: '113.803', lcgt3: '128.987', drift: '154.793' },
  montreal: { lcf1: '93.796', lcgt3: '106.663', drift: '125.140' },
  monaco: { lcf1: '95.415', lcgt3: '108.015', drift: '129.083' },
  barcelona: { lcf1: '98.597', lcgt3: '114.500', drift: '139.402' },
  spielberg: { lcf1: '84.080', lcgt3: '98.901', drift: '116.287' },
  spa: { lcf1: '137.918', lcgt3: '158.782', drift: '193.374' },
  hungaroring: { lcf1: '103.014', lcgt3: '118.607', drift: '141.232' },
  zandvoort: { lcf1: '97.017', lcgt3: '111.803', drift: '134.716' },
  monza: { lcf1: '106.156', lcgt3: '119.465', drift: '139.616' },
  madrid: { lcf1: '128.259', lcgt3: '147.765', drift: '177.300' },
  baku: { lcf1: '132.938', lcgt3: '152.232', drift: '174.202' },
  singapore: { lcf1: '118.152', lcgt3: '135.727', drift: '159.088' },
  austin: { lcf1: '128.476', lcgt3: '148.539', drift: '174.843' },
  mexico: { lcf1: '101.737', lcgt3: '116.083', drift: '135.949' },
  saopaulo: { lcf1: '94.338', lcgt3: '108.168', drift: '131.179' },
  lasvegas: { lcf1: '117.605', lcgt3: '134.563', drift: '158.492' },
  lusail: { lcf1: '114.683', lcgt3: '132.175', drift: '158.023' },
  yasmarina: { lcf1: '113.081', lcgt3: '129.532', drift: '152.468' },
  bahrain: { lcf1: '117.158', lcgt3: '135.226', drift: '156.183' },
  jeddah: { lcf1: '125.261', lcgt3: '143.549', drift: '175.165' },
};

// Laps pinned as they are although not clean: the drift car slides wide in Spa's fast sweepers (Blanchimont, then
// into the Bus Stop) and has the lap deleted. Its time is still pinned, so a change shows up.
const NOT_CLEAN: Partial<Record<TrackId, CarId[]>> = { spa: ['drift'] };

export function calendarLaps(track: keyof typeof CALENDAR) {
  for (const [car, time] of Object.entries(CALENDAR[track]) as [CarId, string][]) {
    const clean = !NOT_CLEAN[track]?.includes(car);
    it(`${car} laps ${track} ${clean ? 'cleanly ' : ''}in ${time} s`, () => lapCheck(track, car, true, time, 240, clean));
  }
}

async function lapCheck(track: TrackId, car: CarId, tc: boolean, time: string, limit: number, clean = true) {
  const { timing, drive, car: c, track: tr, session: s } = await session(car, { tc, track, flying: true });
  const startS = tr.L - TRACKS[track].startBack, flying = TRACKS[track].flying[car];
  expect(c.speedF * 3.6).toBeCloseTo(flying, 0);
  let atStart = -1;   // the speed (km/h) passing the start spot again at the end of the lap
  let resets = 0, nearWall = Infinity;   // how close the car's centre came to a wall (m)
  s.onReset = () => { resets++; };
  drive(limit, null, () => {   // stops after the first lap; the limit catches a car that never gets there
    const p = c.proj;
    if ((p.lat > 0 ? tr.barLValid : tr.barRValid)[p.i]) nearWall = Math.min(nearWall, (p.lat > 0 ? tr.barL : tr.barR)[p.i] - Math.abs(p.lat));
    // (and the pit lane's walls: the pit wall, the far wall, the joins)
    if (tr.pit && pitFootprint(tr.pit, c.pos.x, c.pos.z, 3)) nearWall = Math.min(nearWall, laneWallDistance(tr, c.pos.x, c.pos.z));
    if (atStart < 0 && timing.lapStart != null && timing.next === 0 && p.s >= startS && p.s < tr.L - 1) atStart = c.speedF * 3.6;
    return timing.laps.length > 0;
  });
  expect.soft(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, clean]]);   // soft: the checks below still run
  expect(resets).toBe(0);
  if (clean) expect(nearWall).toBeGreaterThan(2);   // never within reach of a wall (the cars are about 2 m wide)
  // the flying start is the speed the car really has there on a lap: retake TrackDef.flying if this drifts
  expect(atStart).toBeGreaterThan(flying - 2);
  expect(atStart).toBeLessThan(flying + 2);
}

// The distance from (x, z) to the nearest of the pit lane's walls.
export function laneWallDistance(tr: Track, x: number, z: number): number {
  let best = Infinity;
  for (const [pl] of laneWalls(tr.pit!)) for (let j = 0; j + 3 < pl.length; j += 2) {
    const ax = pl[j], az = pl[j + 1], dx = pl[j + 2] - ax, dz = pl[j + 3] - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return best;
}
