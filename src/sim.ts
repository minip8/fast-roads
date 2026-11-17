import RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { autopilot } from './autopilot';
import { Car } from './car';
import type { AnyCarSpec, CarInfo } from './cars';
import { collide, contactBody, newBody, type Contact, type ContactBody } from './collide';
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

// Another car in the session (an opponent), driven by its own driver; it has no timing. Placed at `start` (s, lat in
// track coordinates, rolling at speed m/s) when added and on every restart or reset of its own.
export interface ExtraCar {
  readonly car: Vehicle;
  driver: (car: Vehicle, simTime: number) => DriveInput;
  readonly start: { readonly s: number; readonly lat: number; readonly speed: number };
  stuck: number;                // s below 1 m/s (put back at its start after STUCK_SECS)
}

// A car-to-car contact in the last tick: two of the session's cars (both got their side), or one of them against a
// proxy body (only `a` got its side). The contact holds the closing speed, point and normal (from a to b).
export interface CarContact {
  readonly a: Vehicle;
  readonly b: Vehicle | ContactBody;
  readonly contact: Contact;
}

// Physics world with the track's walls, one car at the start spot, and its lap timing. RAPIER.init() must have resolved.
// Other cars can be added (addCar) and bodies simulated elsewhere put in `proxies`: with either, every tick resolves
// the contacts between all of them (collide.ts) after the cars have moved; with neither, a tick is stepPhysics alone.
export class Session {
  readonly world: RAPIER.World;
  readonly timing: Timing;
  readonly wallCount: number;
  car: Vehicle;                 // replaced by setCar: read it at call time, never keep a reference
  simTime = 0;
  onReset = () => {};           // after the car is moved (restart, new car): the game snaps its camera
  readonly others: ExtraCar[] = [];   // the cars besides `car` (addCar / removeCar)
  // Bodies simulated elsewhere (another player's car), as of this tick: the caller keeps them up to date. The session's
  // cars are pushed off them; they are never moved here.
  readonly proxies: ContactBody[] = [];
  readonly contacts: CarContact[] = [];   // the last tick's car-to-car contacts
  private readonly inputs: DriveInput[] = [];
  private readonly bodyA: ContactBody = newBody({ front: 0, rear: 0, halfWidth: 0, mass: 0, yawInertia: 0 });
  private readonly bodyB: ContactBody = newBody(this.bodyA.shape);
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
    if (this.others.length === 0 && this.proxies.length === 0) {
      if (this.contacts.length) this.contacts.length = 0;
      stepPhysics(this.world, this.car, this.timing, inp, this.simTime);
    } else this.stepAll(inp);
    this.simTime += DT;
    this.stuck = autopilot && Math.abs(this.car.speedF) < 1 ? this.stuck + DT : 0;
    if (this.stuck > STUCK_SECS || needsReset(this.car)) this.restart();
    for (const o of this.others) {
      o.stuck = Math.abs(o.car.speedF) < 1 ? o.stuck + DT : 0;
      if (o.stuck > STUCK_SECS || needsReset(o.car)) this.placeExtra(o);
    }
  }

  // stepPhysics for every car at once: each driver reads the state before anyone moves, the Rapier world steps once,
  // then the contacts are resolved before the player's lap timing sees where the car ended up.
  private stepAll(inp: DriveInput) {
    const car = this.car, others = this.others, inputs = this.inputs;
    for (let k = 0; k < others.length; k++) inputs[k] = finiteInput(others[k].driver(others[k].car, this.simTime));
    inputs.length = others.length;
    prevXZ.x = car.pos.x; prevXZ.z = car.pos.z;
    let rapier = car.spec.physics === 'rapier';
    car.prevPos.copy(car.pos); car.prevQuat.copy(car.quat);
    car.step(DT, finiteInput(inp));
    for (let k = 0; k < others.length; k++) {
      const c = others[k].car;
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
      c.step(DT, inputs[k]);
      rapier ||= c.spec.physics === 'rapier';
    }
    if (rapier) this.world.step();
    car.readState();
    for (const o of others) o.car.readState();
    this.resolveContacts();
    currXZ.x = car.pos.x; currXZ.z = car.pos.z;
    this.timing.tick(prevXZ, currXZ, this.simTime, DT, car);
  }

  // Every pair of the session's cars (both sides applied), then each of them against every proxy (its side only).
  // One pass a tick, in a fixed order; a car shoved by one contact meets the next with its new state.
  private resolveContacts() {
    this.contacts.length = 0;
    const n = this.others.length + 1, at = (k: number) => k === 0 ? this.car : this.others[k - 1].car;
    for (let i = 0; i < n; i++) {
      const a = at(i);
      for (let j = i + 1; j < n; j++) {
        const b = at(j), c = collide(contactBody(a, this.bodyA), contactBody(b, this.bodyB));
        if (!c) continue;
        a.applyContact(c.a); b.applyContact(c.b);
        this.contacts.push({ a, b, contact: c });
      }
      for (const p of this.proxies) {
        const c = collide(contactBody(a, this.bodyA), p);
        if (!c) continue;
        a.applyContact(c.a);
        this.contacts.push({ a, b: p, contact: c });
      }
    }
  }

  // Another car (its own driver: the autopilot unless given), at (s, lat) rolling at `speed` m/s (by default the
  // car's flying speed at the start spot). Not timed. Its mesh is in the scene; the game renders it each frame.
  addCar(spec: AnyCarSpec, { s = this.startS, lat = 0, speed = (this.def.flying?.[spec.id] ?? 0) / 3.6,
    driver = (c: Vehicle) => autopilot(c, this.track) }: { s?: number; lat?: number; speed?: number; driver?: ExtraCar['driver'] } = {}): ExtraCar {
    const o: ExtraCar = { car: createVehicle(this.world, this.track, this.scene, spec), driver, start: { s: ((s % this.track.L) + this.track.L) % this.track.L, lat, speed }, stuck: 0 };
    this.others.push(o);
    this.placeExtra(o);
    return o;
  }

  removeCar(o: ExtraCar) {
    const k = this.others.indexOf(o);
    if (k < 0) return;
    this.others.splice(k, 1);
    o.car.destroy();
  }

  // Back to the start of the lap, which is every reset there is (the player's, a stuck autopilot, a car on its roof):
  // on the straight before the last corner or corners, already at the speed of a flying lap. The lap under way is
  // dropped and the next starts at the line, after the run-up through those corners.
  restart() {
    this.place();
    this.timing.reset();
    for (const o of this.others) this.placeExtra(o);
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

  private placeExtra(o: ExtraCar) {
    o.car.placeAt(o.start.s, o.start.lat, o.start.speed);
    o.stuck = 0;
  }
}
