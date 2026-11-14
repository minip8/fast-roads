// Headless game session for tests: the game's own Session (track, physics world, one car and lap timing), with no
// rendering.
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { autopilot } from '../src/autopilot';
import type { Car, DriveInput } from '../src/car';
import { CARS, type CarId } from '../src/cars';
import { DT } from '../src/config';
import { Session } from '../src/sim';
import { buildTrack, parseCSV, type Track } from '../src/track';

let track: Track | null = null;

export async function session(carId: CarId, { tc = true } = {}) {
  await RAPIER.init();
  track ??= buildTrack(parseCSV(readFileSync(new URL('../tracks/melbourne.csv', import.meta.url), 'utf8')));
  const tr = track;
  const s = new Session(tr, new THREE.Scene(), CARS[carId]);
  const { car, timing, world } = s;
  car.tc = tc;

  // Drive for `seconds`, or until `until()` is true after a tick; the default driver is the autopilot. Same ticks and
  // resets as the game loop.
  const drive = (seconds: number, driver?: ((car: Car, t: number) => DriveInput) | null, until?: () => boolean) => {
    for (let k = 0, n = Math.round(seconds / DT); k < n; k++) {
      s.tick(driver ? driver(car, s.simTime) : autopilot(car, tr), !driver);
      if (until?.()) return;
    }
  };
  return { track: tr, world, car, timing, drive };
}
