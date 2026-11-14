import type RAPIER from '@dimforge/rapier3d-compat';
import type { Car, DriveInput } from './car';
import { DT } from './config';
import type { Timing } from './timing';

type XZ = { x: number; z: number };
const prevXZ: XZ = { x: 0, z: 0 }, currXZ: XZ = { x: 0, z: 0 };

// One fixed physics tick: car forces, Rapier step, then lap timing (crossings are interpolated within the tick).
// Shared by the game loop and the tests, so both run exactly the same simulation.
export function stepPhysics(world: RAPIER.World, car: Car, timing: Timing, inp: DriveInput, simTime: number) {
  car.prevPos.copy(car.pos); car.prevQuat.copy(car.quat);
  prevXZ.x = car.pos.x; prevXZ.z = car.pos.z;
  car.step(DT, inp);
  world.step();
  car.readState();
  currXZ.x = car.pos.x; currXZ.z = car.pos.z;
  timing.tick(prevXZ, currXZ, simTime, DT, car);
}

// The car needs putting back on track: fell through the world, flipped and stopped, or stuck on its side.
export const needsReset = (car: Car) => car.pos.y < -5 || (car.up.y < -0.3 && car.speedF < 2) || car.tipped > 1.5;
