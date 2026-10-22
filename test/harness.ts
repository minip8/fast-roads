// Headless game session for tests: track, physics world, one car and lap timing, with no rendering.
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { autopilot } from '../src/autopilot';
import { Car, type DriveInput } from '../src/car';
import { CARS, type CarId } from '../src/cars';
import { DT } from '../src/config';
import { needsReset, stepPhysics } from '../src/sim';
import { Timing } from '../src/timing';
import { buildTrack, buildTrackColliders, parseCSV, type Track } from '../src/track';

let track: Track | null = null;

export async function session(carId: CarId, { tc = true } = {}) {
  await RAPIER.init();
  track ??= buildTrack(parseCSV(readFileSync(new URL('../tracks/melbourne.csv', import.meta.url), 'utf8')));
  const tr = track;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  buildTrackColliders(tr, world);
  const car = new Car(world, tr, new THREE.Scene(), CARS[carId]);
  car.tc = tc;
  car.placeAt(tr.L - 160, 0);                   // the game's grid spot
  const timing = new Timing(tr, `test.${carId}`);
  let simTime = 0, autoStuck = 0;

  // Drive for `seconds`; the default driver is the autopilot. Same resets as the game loop.
  const drive = (seconds: number, driver?: (car: Car, t: number) => DriveInput) => {
    const auto = !driver;
    for (let k = 0, n = Math.round(seconds / DT); k < n; k++) {
      stepPhysics(world, car, timing, driver ? driver(car, simTime) : autopilot(car, tr), simTime);
      simTime += DT;
      autoStuck = auto && Math.abs(car.speedF) < 1 ? autoStuck + DT : 0;
      if (autoStuck > 3 || needsReset(car)) { autoStuck = 0; car.placeAt(car.proj.s, 0); timing.invalidate('RESET'); }
    }
  };
  return { track: tr, world, car, timing, drive };
}
