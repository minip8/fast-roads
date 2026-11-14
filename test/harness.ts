// Headless game session for tests: the game's own Session (track, physics world, one car and lap timing), with no
// rendering.
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { autopilot } from '../src/autopilot';
import type { Car, DriveInput } from '../src/car';
import { CARS, type CarId } from '../src/cars';
import { DT, G_WALL } from '../src/config';
import { Session } from '../src/sim';
import { buildTrack, parseCSV, type Track } from '../src/track';

let track: Track | null = null;

// `walls: false` removes the barriers, for manoeuvres that need more room than the walled start straight has.
export async function session(carId: CarId, { tc = true, walls = true } = {}) {
  await RAPIER.init();
  track ??= buildTrack(parseCSV(readFileSync(new URL('../tracks/melbourne.csv', import.meta.url), 'utf8')));
  const tr = track;
  const s = new Session(tr, new THREE.Scene(), CARS[carId]);
  const { car, timing, world } = s;
  car.tc = tc;
  if (!walls) {
    const handles: number[] = [];
    world.forEachCollider((c) => { if ((c.collisionGroups() >>> 16) & G_WALL) handles.push(c.handle); });
    for (const h of handles) world.removeCollider(world.getCollider(h), false);
  }

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
