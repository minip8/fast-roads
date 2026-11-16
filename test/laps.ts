import { expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import { TRACKS, type TrackId } from '../src/tracks';
import { session } from './harness';

// Autopilot lap times from the game's flying start, pinned to the millisecond. The simulation is deterministic, so
// they only change when physics or car tuning changes (or the start: TrackDef.startBack and .flying). If you changed handling on purpose, check the car still behaves, then update them here.
// Each lap has its own test file (laps-*.test.ts), so Vitest runs them in parallel.
const EXPECTED = {
  drift: { track: 'melbourne', car: 'drift', tc: true, time: '157.514', limit: 200 },
  driftNoTc: { track: 'melbourne', car: 'drift', tc: false, time: '157.491', limit: 200 },
  silverstoneDrift: { track: 'silverstone', car: 'drift', tc: true, time: '169.794', limit: 220 },
  // on LibreCorsa's engine (src/lc)
  lcGt3: { track: 'melbourne', car: 'lcgt3', tc: true, time: '133.917', limit: 170 },
  silverstoneLcGt3: { track: 'silverstone', car: 'lcgt3', tc: true, time: '144.234', limit: 190 },
  lcF1: { track: 'melbourne', car: 'lcf1', tc: true, time: '116.317', limit: 150 },
  silverstoneLcF1: { track: 'silverstone', car: 'lcf1', tc: true, time: '123.798', limit: 160 },
} satisfies Record<string, { track: TrackId; car: CarId; tc: boolean; time: string; limit: number }>;

export function lapTest(lap: keyof typeof EXPECTED) {
  const { track, car, tc, time, limit } = EXPECTED[lap];
  it(`${car} laps ${track} cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, () => lapCheck(track, car, tc, time, limit));
}

// The rest of the calendar, TC on: run by npm run test:laps (test/calendar/<circuit>.test.ts, one file per circuit).
type Times = Record<CarId, string>;
const CALENDAR: Record<Exclude<TrackId, 'melbourne' | 'silverstone'>, Times> = {
  shanghai: { lcf1: '120.184', lcgt3: '139.227', drift: '165.784' },
  suzuka: { lcf1: '118.530', lcgt3: '137.851', drift: '167.865' },
  miami: { lcf1: '113.615', lcgt3: '129.028', drift: '154.800' },
  montreal: { lcf1: '93.510', lcgt3: '106.732', drift: '125.140' },
  monaco: { lcf1: '95.240', lcgt3: '108.081', drift: '129.083' },
  barcelona: { lcf1: '98.267', lcgt3: '114.542', drift: '139.404' },
  spielberg: { lcf1: '83.925', lcgt3: '98.958', drift: '116.292' },
  spa: { lcf1: '137.968', lcgt3: '158.819', drift: '193.446' },
  hungaroring: { lcf1: '102.892', lcgt3: '118.742', drift: '141.234' },
  zandvoort: { lcf1: '96.493', lcgt3: '111.853', drift: '134.711' },
  monza: { lcf1: '105.442', lcgt3: '119.518', drift: '139.623' },
  madrid: { lcf1: '128.112', lcgt3: '147.820', drift: '177.298' },
  baku: { lcf1: '132.032', lcgt3: '152.290', drift: '174.205' },
  singapore: { lcf1: '117.737', lcgt3: '135.793', drift: '159.067' },
  austin: { lcf1: '128.626', lcgt3: '148.607', drift: '174.839' },
  mexico: { lcf1: '101.426', lcgt3: '116.162', drift: '135.953' },
  saopaulo: { lcf1: '93.564', lcgt3: '108.228', drift: '131.182' },
  lasvegas: { lcf1: '117.429', lcgt3: '134.623', drift: '158.494' },
  lusail: { lcf1: '116.032', lcgt3: '132.204', drift: '158.022' },
  yasmarina: { lcf1: '113.014', lcgt3: '129.579', drift: '152.475' },
  bahrain: { lcf1: '117.049', lcgt3: '135.290', drift: '156.185' },
  jeddah: { lcf1: '124.880', lcgt3: '143.598', drift: '175.162' },
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
    if (atStart < 0 && timing.lapStart != null && timing.next === 0 && p.s >= startS && p.s < tr.L - 1) atStart = c.speedF * 3.6;
    return timing.laps.length > 0;
  });
  expect(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, clean]]);
  expect(resets).toBe(0);
  if (clean) expect(nearWall).toBeGreaterThan(2);   // never within reach of a wall (the cars are about 2 m wide)
  // the flying start is the speed the car really has there on a lap: retake TrackDef.flying if this drifts
  expect(atStart).toBeGreaterThan(flying - 2);
  expect(atStart).toBeLessThan(flying + 2);
}
