import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { Car, type DriveInput } from './car';
import type { CarSpec } from './cars';
import { DT } from './config';
import { Timing } from './timing';
import { buildTrackColliders, type Track } from './track';

// ============================================================================
// Simulation: one physics tick, and the session that owns the world, car and timing. The game loop and the tests
// both drive a Session, so they simulate exactly the same thing (rendering, input and sound stay in main.ts).
// ============================================================================
const GRID_BACK = 160;    // m: the grid spot is this far before the start/finish line
const STUCK_SECS = 3;     // the autopilot below 1 m/s for this long (against a wall) is put back on track

type XZ = { x: number; z: number };
const prevXZ: XZ = { x: 0, z: 0 }, currXZ: XZ = { x: 0, z: 0 };

// One fixed physics tick: car forces, Rapier step, then lap timing (crossings are interpolated within the tick).
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

// Physics world with the track's walls, one car on the grid, and its lap timing. RAPIER.init() must have resolved.
export class Session {
  readonly world: RAPIER.World;
  readonly timing: Timing;
  readonly wallCount: number;
  car: Car;                     // replaced by setCar: read it at call time, never keep a reference
  simTime = 0;
  onReset = () => {};           // after the car is moved (reset, restart, new car): the game snaps its camera
  private readonly gridS: number;
  private stuck = 0;

  constructor(readonly track: Track, private readonly scene: THREE.Scene, spec: CarSpec) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = DT;
    this.wallCount = buildTrackColliders(track, this.world);
    this.gridS = track.L - GRID_BACK;
    this.car = new Car(this.world, track, scene, spec);
    this.car.placeAt(this.gridS, 0);
    this.timing = new Timing(track, spec.storeKey);
  }

  // One physics tick. autopilot: the autopilot is driving (so it is put back on track if it gets stuck).
  tick(inp: DriveInput, autopilot: boolean) {
    stepPhysics(this.world, this.car, this.timing, inp, this.simTime);
    this.simTime += DT;
    this.stuck = autopilot && Math.abs(this.car.speedF) < 1 ? this.stuck + DT : 0;
    if (this.stuck > STUCK_SECS || needsReset(this.car)) this.resetToTrack();
  }

  // Back on the track where the car is (invalidates the lap).
  resetToTrack() {
    this.place(this.car.proj.s);
    this.timing.invalidate('RESET');
  }

  // Back to the grid; the next lap starts at the line.
  restart() {
    this.place(this.gridS);
    this.timing.reset();
  }

  // Swap in another car (with default driver settings: the caller applies its own) on the grid, with its best times.
  setCar(spec: CarSpec) {
    this.car.destroy();
    this.car = new Car(this.world, this.track, this.scene, spec);
    this.timing.useStore(spec.storeKey);
    this.restart();
  }

  private place(s: number) {
    this.car.placeAt(s, 0);
    this.stuck = 0;
    this.onReset();
  }
}
