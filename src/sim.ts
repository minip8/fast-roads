import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { Car } from './car';
import type { AnyCarSpec, CarInfo } from './cars';
import { DT } from './config';
import { LcCar } from './lc/lcCar';
import { Timing } from './timing';
import { buildTrackColliders, type Track } from './track';
import type { TrackDef } from './tracks';
import type { DriveInput, Vehicle } from './vehicle';

// ============================================================================
// Simulation: one physics tick, and the session that owns the world, car and timing. The game loop and the tests
// both drive a Session, so they simulate exactly the same thing (rendering, input and sound stay in main.ts).
// ============================================================================
const STUCK_SECS = 3;     // the autopilot below 1 m/s for this long (against a wall) is put back on track

type XZ = { x: number; z: number };
const prevXZ: XZ = { x: 0, z: 0 }, currXZ: XZ = { x: 0, z: 0 };

// A NaN or infinity reaching Rapier poisons the body for the rest of the session, so a bad input (a driver bug, an odd
// gamepad) is replaced by a neutral one. Valid input is passed through untouched.
const neutral: DriveInput = { throttle: 0, brake: 0, steer: 0, analog: false, steerAngle: null };
let warned = false;
function finiteInput(inp: DriveInput): DriveInput {
  const ok = Number.isFinite(inp.throttle) && Number.isFinite(inp.brake) && Number.isFinite(inp.steer)
    && (inp.steerAngle == null || Number.isFinite(inp.steerAngle));
  if (ok) return inp;
  if (!warned) { warned = true; console.warn('Ignoring non-finite drive input', { ...inp }); }
  return { ...neutral, autoGears: inp.autoGears };
}

// One fixed physics tick: car forces, Rapier step, then lap timing (crossings are interpolated within the tick).
export function stepPhysics(world: RAPIER.World, car: Vehicle, timing: Timing, inp: DriveInput, simTime: number) {
  car.prevPos.copy(car.pos); car.prevQuat.copy(car.quat);
  prevXZ.x = car.pos.x; prevXZ.z = car.pos.z;
  car.step(DT, finiteInput(inp));
  if (car.spec.physics === 'rapier') world.step();   // other engines move their own body; the world's 2,600 walls cost 0.4 ms to step for nothing
  car.readState();
  currXZ.x = car.pos.x; currXZ.z = car.pos.z;
  timing.tick(prevXZ, currXZ, simTime, DT, car);
}

// The car needs putting back on track: fell through the world, flipped and stopped, or stuck on its side.
export const needsReset = (car: Vehicle) => car.pos.y < -5 || (car.up.y < -0.3 && car.speedF < 2) || car.tipped > 1.5;

// The car for a spec, on the engine the spec names. Every engine gets the Rapier world (with the track's walls) and is
// stepped by stepPhysics, whether or not it uses the world. A new engine is a case here and a member of AnyCarSpec.
export function createVehicle(world: RAPIER.World, track: Track, scene: THREE.Scene, spec: AnyCarSpec): Vehicle {
  switch (spec.physics) {
    case 'rapier': return new Car(world, track, scene, spec);
    case 'lc': return new LcCar(world, track, scene, spec);
    default: { const unhandled: never = spec, s = unhandled as CarInfo; throw new Error(`No physics engine '${s.physics}' (${s.id})`); }
  }
}

// Physics world with the track's walls, one car at the start spot, and its lap timing. RAPIER.init() must have resolved.
export class Session {
  readonly world: RAPIER.World;
  readonly timing: Timing;
  readonly wallCount: number;
  car: Vehicle;                 // replaced by setCar: read it at call time, never keep a reference
  simTime = 0;
  onReset = () => {};           // after the car is moved (restart, new car): the game snaps its camera
  private readonly startS: number;
  private stuck = 0;

  // def: the circuit's start spot (which is also the run-up timing watches for track limits), each car's flying-lap
  // speed there, and its localStorage key for best times (each car adds its own suffix). Without `flying` the car
  // starts at rest (tests of manoeuvres from a standstill, which put the start spot on the start straight).
  constructor(readonly track: Track, private readonly scene: THREE.Scene, spec: AnyCarSpec,
    private readonly def: Pick<TrackDef, 'storeKey' | 'startBack'> & Partial<Pick<TrackDef, 'flying'>>) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = DT;
    this.wallCount = buildTrackColliders(track, this.world);
    this.startS = track.L - def.startBack;
    this.car = createVehicle(this.world, track, scene, spec);
    this.place();
    this.timing = new Timing(track, def.storeKey + spec.storeKey, def.startBack);
  }

  // One physics tick. autopilot: the autopilot is driving (so it is put back on track if it gets stuck).
  tick(inp: DriveInput, autopilot: boolean) {
    stepPhysics(this.world, this.car, this.timing, inp, this.simTime);
    this.simTime += DT;
    this.stuck = autopilot && Math.abs(this.car.speedF) < 1 ? this.stuck + DT : 0;
    if (this.stuck > STUCK_SECS || needsReset(this.car)) this.restart();
  }

  // Back to the start of the lap, which is every reset there is (the player's, a stuck autopilot, a car on its roof):
  // on the straight before the last corner or corners, already at the speed of a flying lap. The lap under way is
  // dropped and the next starts at the line, after the run-up through those corners.
  restart() {
    this.place();
    this.timing.reset();
  }

  // Swap in another car (with default driver settings: the caller applies its own) at the start, with its best times.
  setCar(spec: AnyCarSpec) {
    this.car.destroy();
    this.car = createVehicle(this.world, this.track, this.scene, spec);
    this.timing.useStore(this.def.storeKey + spec.storeKey);
    this.restart();
  }

  private place() {
    this.car.placeAt(this.startS, 0, (this.def.flying?.[this.car.spec.id] ?? 0) / 3.6);
    this.stuck = 0;
    this.onReset();
  }
}
