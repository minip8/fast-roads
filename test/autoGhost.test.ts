// The Ghost car setting's Autopilot laps (public/ghosts/, test/autoGhost.ts): a file for every car at every circuit
// that is the lap its lap test pins (checked cheaply here by its lap time; the lap tests compare the whole lap), and
// loadAutoGhost.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARS, type CarId } from '../src/cars';
import { autoGhostFile, loadAutoGhost } from '../src/ghost';
import { TRACKS, type TrackId } from '../src/tracks';
import { policyOwnsGhost, readAutoGhost } from './autoGhost';
import { pinnedLap } from './laps';
import { gamePolicy } from './policies';

const cars = Object.keys(CARS) as CarId[], tracks = Object.keys(TRACKS) as TrackId[];
type EvalLap = { track: string; car: string; lap_time: number | null; laps?: [number, boolean][] };

describe('the autopilot ghost laps', () => {
  it('are one file per car and circuit, and no others', () => {
    const want = tracks.flatMap((t) => cars.map((c) => autoGhostFile(c, t).replace('ghosts/', ''))).sort();
    expect(readdirSync('public/ghosts').sort()).toEqual(want);
  });

  it.each(tracks)('at %s are the laps the lap tests pin', (track) => {
    for (const car of cars) {
      const lap = readAutoGhost(car, track), file = autoGhostFile(car, track);
      // from the line to the line: it starts within a tick of the lap's start and ends as the lap does
      expect(lap.t0, file).toBeLessThanOrEqual(0);
      expect(lap.tEnd, file).toBeGreaterThanOrEqual(lap.lapTime);
      expect(lap.dist[lap.n - 1] / (TRACKS[track].lengthKm * 1000), file).toBeGreaterThan(0.97);
      expect(lap.dist[lap.n - 1] / (TRACKS[track].lengthKm * 1000), file).toBeLessThan(1.06);
      if (!policyOwnsGhost(car, track)) { expect(lap.lapTime.toFixed(3), file).toBe(pinnedLap(track, car)); continue; }
      // a trained policy's: its first lap, which test/policyLap.ts holds within 1.5 s of the trainer's evaluation
      const ev = (gamePolicy(car, track)!.policy.meta.provenance.eval as EvalLap[] | undefined)?.find((r) => r.track === track && r.car === car);
      const first = ev?.laps ? ev.laps[0][0] : ev?.lap_time;
      expect(Math.abs(lap.lapTime - first!), file).toBeLessThan(1.5);
      expect(lap.lapTime, file).toBeLessThan(Number(pinnedLap(track, car)));   // (quicker than the built-in autopilot)
    }
  });
});

describe('loadAutoGhost', () => {
  const bytes = readFileSync(`public/${autoGhostFile('drift', 'melbourne')}`);
  const serve = (status: number, body: Uint8Array) => {
    const asked: { url: string; cache?: string }[] = [];
    const get = ((url: string, init?: RequestInit) => {
      asked.push({ url, cache: init?.cache });
      return Promise.resolve(new Response(new Uint8Array(body), { status }));
    }) as typeof fetch;
    return { asked, get };
  };

  it('fetches the car and circuit’s file from the base URL and unpacks it', async () => {
    const { asked, get } = serve(200, bytes);
    const lap = await loadAutoGhost('./', 'drift', 'melbourne', get);
    expect(asked).toEqual([{ url: './ghosts/drift-melbourne.bin', cache: 'no-cache' }]);
    expect(lap!.lapTime.toFixed(3)).toBe(pinnedLap('melbourne', 'drift'));
    expect(lap).toEqual(readAutoGhost('drift', 'melbourne'));
  });

  it('gives null for a missing file, a file that is not a lap and a failed fetch', async () => {
    expect(await loadAutoGhost('./', 'drift', 'melbourne', serve(404, bytes).get)).toBeNull();
    expect(await loadAutoGhost('./', 'drift', 'melbourne', serve(200, bytes.subarray(0, 500)).get)).toBeNull();
    expect(await loadAutoGhost('./', 'drift', 'melbourne', serve(200, new TextEncoder().encode('<!doctype html>')).get)).toBeNull();
    expect(await loadAutoGhost('./', 'drift', 'melbourne', (() => Promise.reject(new Error('offline'))) as typeof fetch)).toBeNull();
  });
});
