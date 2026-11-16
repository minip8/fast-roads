// Headless game session for tests: the game's own Session (track, physics world, one car and lap timing), with no
// rendering.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { autopilot } from '../src/autopilot';
import { Car } from '../src/car';
import { CARS, type AnyCarSpec, type CarId, type CarSpec } from '../src/cars';
import { DT, G_WALL } from '../src/config';
import { LcCar } from '../src/lc/lcCar';
import { Session } from '../src/sim';
import { buildTrack, parseCSV, type Track } from '../src/track';
import { loadTrackCsv, TRACKS, type TrackId } from '../src/tracks';
import type { DriveInput, Vehicle } from '../src/vehicle';

const tracks: Partial<Record<TrackId, Track>> = {};
// Each circuit is built once per test file.
export async function trackFor(id: TrackId): Promise<Track> {
  return tracks[id] ??= buildTrack(parseCSV(await loadTrackCsv(id)), { street: TRACKS[id].street });
}

// Where a car starting at rest is put: on the start straight, this far before the line (m). The game's start spot is
// before the last corner, with no room for manoeuvres from a standstill.
export const REST_BACK: Partial<Record<TrackId, number>> = { melbourne: 160, silverstone: 60 };

// `walls: false` removes the barriers, for manoeuvres that need more room than the walled start straight has.
// The car starts at rest on the start straight (REST_BACK); `flying: true` starts it as the game does, at the
// circuit's start spot at flying-lap speed.
export async function session(carId: CarId, { tc = true, walls = true, track = 'melbourne' as TrackId, flying = false } = {}) {
  await RAPIER.init();
  const def = TRACKS[track], tr = await trackFor(track), rest = REST_BACK[track];
  if (!flying && rest == null) throw new Error(`no REST_BACK for ${track}`);
  const s = new Session(tr, new THREE.Scene(), CARS[carId], flying ? def : { storeKey: def.storeKey, startBack: rest! });
  const { car, timing, world } = s;
  car.tc = tc;
  if (!walls) {
    const handles: number[] = [];
    world.forEachCollider((c) => { if ((c.collisionGroups() >>> 16) & G_WALL) handles.push(c.handle); });
    for (const h of handles) world.removeCollider(world.getCollider(h), false);
    if (car instanceof LcCar) car.setBarriers(false);   // LibreCorsa's engine meets the barriers without Rapier
  }

  // Drive for `seconds`, or until `until()` is true after a tick; the default driver is the autopilot. Same ticks and
  // resets as the game loop.
  const drive = (seconds: number, driver?: ((car: Vehicle, t: number) => DriveInput) | null, until?: () => boolean) => {
    for (let k = 0, n = Math.round(seconds / DT); k < n; k++) {
      s.tick(driver ? driver(car, s.simTime) : autopilot(car, tr), !driver);
      if (until?.()) return;
    }
  };
  return { track: tr, world, car, timing, drive, session: s };
}

// For tests that reach into our own physics (the Rapier body, its tuning numbers): the car or spec as ours, or a
// failed test if the car runs on another engine.
export function ourCar(car: Vehicle): Car {
  if (!(car instanceof Car)) throw new Error(`${car.spec.id} does not run on our physics`);
  return car;
}
export function ourSpec(spec: AnyCarSpec): CarSpec {
  if (spec.physics !== 'rapier') throw new Error(`${(spec as { id: string }).id} does not run on our physics`);
  return spec;
}
