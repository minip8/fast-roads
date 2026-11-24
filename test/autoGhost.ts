// The autopilot's ghost laps (public/ghosts/<car>-<track>.bin: the Ghost car setting's Autopilot choice, ghost.ts
// `loadAutoGhost`). Each is the lap a lap test drives anyway, so those tests check the file against the lap they just
// ran, and with GHOSTS=write in the environment write it instead:
//
//     GHOSTS=write npm test && GHOSTS=write npm run test:laps     # after a change to physics, tuning or a policy
//
// Whose lap a file is: the trained policy's first lap from the flying start where the game has one for the car at
// the circuit (test/policyLap.ts), else the built-in autopilot's with TC on (test/laps.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import { pickPolicy } from '../src/ai/policy';
import type { CarId } from '../src/cars';
import { autoGhostFile, unpackGhost } from '../src/ghost';
import type { TrackId } from '../src/tracks';

const path = (car: CarId, track: TrackId) => `public/${autoGhostFile(car, track)}`;
const REMAKE = 'GHOSTS=write npm test && GHOSTS=write npm run test:laps rewrites them';

// Whether the game has a trained policy for the car at the circuit (public/ai/policies.json): its lap is the file's.
export const policyOwnsGhost = (car: CarId, track: TrackId) =>
  pickPolicy(JSON.parse(readFileSync('public/ai/policies.json', 'utf8')), car, track) != null;

export function readAutoGhost(car: CarId, track: TrackId) {
  const file = path(car, track);
  if (!existsSync(file)) throw new Error(`${file} is missing: ${REMAKE}`);
  const lap = unpackGhost(new Uint8Array(readFileSync(file)));
  if (!lap) throw new Error(`${file} is not a packed lap: ${REMAKE}`);
  return lap;
}

// The lap just driven (Timing.lastRecording) against the file, or written to it. The comparison allows what the
// last bit of a sin or atan2 can move (the pinned lap times allow it too: they are to the millisecond), not more.
export function checkAutoGhost(car: CarId, track: TrackId, packed: Uint8Array | null) {
  const file = path(car, track), got = packed && unpackGhost(packed);
  if (!packed || !got) throw new Error(`no recording of the lap to compare ${file} with`);
  if (process.env.GHOSTS === 'write') {
    mkdirSync('public/ghosts', { recursive: true });
    writeFileSync(file, packed);
    return;
  }
  const want = readAutoGhost(car, track);
  let off = 0;
  for (let i = 0; i < Math.min(got.n, want.n); i++) off = Math.max(off, Math.hypot(got.x[i] - want.x[i], got.y[i] - want.y[i], got.z[i] - want.z[i]));
  expect({ file, samples: got.n, lapTime: got.lapTime.toFixed(3), apart: off < 0.25 }, `${file} is not the lap driven here (${off.toFixed(2)} m apart at most): ${REMAKE}`)
    .toEqual({ file, samples: want.n, lapTime: want.lapTime.toFixed(3), apart: true });
}
