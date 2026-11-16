import { expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import { TRACKS, type TrackId } from '../src/tracks';
import { session } from './harness';

// Autopilot lap times from the game's flying start, pinned to the millisecond. The simulation is deterministic, so
// they only change when physics or car tuning changes (or the start: TrackDef.startBack and .flying, before the last
// corners: the drift car's laps come out the same as a lap after a lap, to a few ms; the LibreCorsa cars' depend on
// what the run-up leaves them, tyres from the blankets and the F1's battery, which a restart fills). If you changed handling on purpose, check the car still behaves, then update them here.
// Each lap has its own test file (laps-*.test.ts), so Vitest runs them in parallel.
const EXPECTED = {
  drift: { track: 'melbourne', car: 'drift', tc: true, time: '157.515', limit: 200 },
  driftNoTc: { track: 'melbourne', car: 'drift', tc: false, time: '157.492', limit: 200 },
  silverstoneDrift: { track: 'silverstone', car: 'drift', tc: true, time: '169.789', limit: 220 },
  // on LibreCorsa's engine (src/lc)
  lcGt3: { track: 'melbourne', car: 'lcgt3', tc: true, time: '133.918', limit: 170 },
  silverstoneLcGt3: { track: 'silverstone', car: 'lcgt3', tc: true, time: '144.224', limit: 190 },
  lcF1: { track: 'melbourne', car: 'lcf1', tc: true, time: '116.680', limit: 150 },
  silverstoneLcF1: { track: 'silverstone', car: 'lcf1', tc: true, time: '124.082', limit: 160 },
} satisfies Record<string, { track: TrackId; car: CarId; tc: boolean; time: string; limit: number }>;

export function lapTest(lap: keyof typeof EXPECTED) {
  const { track, car, tc, time, limit } = EXPECTED[lap];
  it(`${car} laps ${track} cleanly with TC ${tc ? 'on' : 'off'} in ${time} s`, () => lapCheck(track, car, tc, time, limit));
}

// The rest of the calendar, TC on: run by npm run test:laps (test/calendar/<circuit>.test.ts, one file per circuit).
type Times = Record<CarId, string>;
const CALENDAR: Record<Exclude<TrackId, 'melbourne' | 'silverstone'>, Times> = {
  shanghai: { lcf1: '120.278', lcgt3: '139.200', drift: '165.784' },
  suzuka: { lcf1: '118.602', lcgt3: '137.850', drift: '167.861' },
  miami: { lcf1: '113.922', lcgt3: '128.979', drift: '154.793' },
  montreal: { lcf1: '94.088', lcgt3: '106.724', drift: '125.140' },
  monaco: { lcf1: '95.527', lcgt3: '108.075', drift: '129.083' },
  barcelona: { lcf1: '98.678', lcgt3: '114.535', drift: '139.402' },
  spielberg: { lcf1: '84.138', lcgt3: '98.946', drift: '116.287' },
  spa: { lcf1: '138.030', lcgt3: '158.808', drift: '193.374' },
  hungaroring: { lcf1: '103.127', lcgt3: '118.716', drift: '141.232' },
  zandvoort: { lcf1: '97.109', lcgt3: '111.839', drift: '134.716' },
  monza: { lcf1: '106.141', lcgt3: '119.505', drift: '139.616' },
  madrid: { lcf1: '128.388', lcgt3: '147.822', drift: '177.300' },
  baku: { lcf1: '133.081', lcgt3: '152.282', drift: '174.202' },
  singapore: { lcf1: '118.271', lcgt3: '135.786', drift: '159.088' },
  austin: { lcf1: '128.629', lcgt3: '148.591', drift: '174.843' },
  mexico: { lcf1: '101.822', lcgt3: '116.200', drift: '135.949' },
  saopaulo: { lcf1: '94.446', lcgt3: '108.213', drift: '131.179' },
  lasvegas: { lcf1: '117.709', lcgt3: '134.613', drift: '158.492' },
  lusail: { lcf1: '114.896', lcgt3: '132.189', drift: '158.023' },
  yasmarina: { lcf1: '113.191', lcgt3: '129.571', drift: '152.468' },
  bahrain: { lcf1: '117.266', lcgt3: '135.268', drift: '156.183' },
  jeddah: { lcf1: '125.375', lcgt3: '143.595', drift: '175.165' },
};

// Laps pinned as they are although not clean: the drift car slides wide in Spa's fast sweepers (Blanchimont, then
// into the Bus Stop) and has the lap deleted. The F1 spins in Monza's Parabolica on the run-up (its tyres fresh from
// the blankets, under full power out of the corner), so the lap after it is deleted. Their times are still pinned,
// so a change shows up.
const NOT_CLEAN: Partial<Record<TrackId, CarId[]>> = { spa: ['drift'], monza: ['lcf1'] };

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
  expect.soft(timing.laps.map((l) => [l.time.toFixed(3), l.valid])).toEqual([[time, clean]]);   // soft: the checks below still run
  expect(resets).toBe(0);
  if (clean) expect(nearWall).toBeGreaterThan(2);   // never within reach of a wall (the cars are about 2 m wide)
  // the flying start is the speed the car really has there on a lap: retake TrackDef.flying if this drifts
  expect(atStart).toBeGreaterThan(flying - 2);
  expect(atStart).toBeLessThan(flying + 2);
}
