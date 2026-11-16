import type * as THREE from 'three';
import type { CarMesh } from './carMeshes';
import type { CarInfo } from './cars';
import type { TrackPos } from './track';

// ============================================================================
// Vehicle: a drivable car as the rest of the game sees it (session, timing, camera, HUD, dust, sound, autopilot),
// whichever physics engine drives it. Car (car.ts) is ours; createVehicle (sim.ts) picks the engine from the spec.
// ============================================================================

// What a driver (keyboard/mouse/gamepad, or the autopilot) asks of the car each physics tick.
export interface DriveInput {
  throttle: number; brake: number;   // 0..1
  steer: number;                     // -1 (right) .. 1 (left); each engine turns it into a wheel angle its own way
  analog: boolean;                   // analog input: faster steering, different lock curve
  steerAngle?: number | null;        // direct wheel angle (rad), overrides steer (autopilot)
  autoGears?: boolean;               // force the automatic gearbox (autopilot)
}

// One wheel, as the HUD, timing, camera, dust and sound read it. Order: FL, FR, RL, RR (as the mesh's wheels).
export interface VehicleWheel {
  readonly grounded: boolean;
  readonly surf: number;             // surface index (SURF in config.ts)
  readonly out: boolean;             // past the track limits (all four out invalidates the lap)
  readonly slip: number;             // combined slip, 1 at the tyre's grip peak whichever way it slips (tyre sound, RL)
  readonly contact: { readonly x: number; readonly y: number; readonly z: number };   // contact point while grounded (dust)
}

// Tyre and brake condition of one wheel (order as `wheels`), for the HUD. Refreshed every tick, never reallocated.
export interface TyreState {
  readonly coreC: number;            // carcass temperature (deg C): what the working window is about
  readonly surfaceC: number;         // tread surface temperature (deg C): reacts within seconds, a quarter of the grip's
  readonly bandsC: readonly [inner: number, middle: number, outer: number];   // ...its inner, middle and outer bands
  readonly pressurePsi: number;      // hot inflation pressure (psi gauge)
  readonly brakeC: number;           // brake disc surface temperature (deg C)
  readonly wear?: number;            // tread worn, 0..1; undefined: the car does not wear its tyres
}
export interface VehicleTyres {
  readonly wheels: readonly TyreState[];
  readonly windowC: readonly (readonly [number, number])[];   // front, rear: carcass temperatures of full grip
  readonly optimalPsi: readonly number[];                      // front, rear: hot pressure of full grip
}

export interface Vehicle {
  readonly spec: CarInfo;
  readonly mesh: CarMesh;            // added to the scene by the vehicle; render() poses it
  readonly wheels: readonly VehicleWheel[];
  // Physics state after the last tick (readState). prevPos/prevQuat: the state a tick earlier, which stepPhysics
  // copies in before each tick and render() interpolates from.
  readonly proj: TrackPos;           // where the car is on the track
  readonly pos: THREE.Vector3; readonly quat: THREE.Quaternion; readonly vel: THREE.Vector3; readonly angv: THREE.Vector3;
  readonly up: THREE.Vector3; readonly fwd: THREE.Vector3; readonly left: THREE.Vector3;   // body axes in world space
  readonly prevPos: THREE.Vector3; readonly prevQuat: THREE.Quaternion;
  readonly speedF: number;           // forward speed (m/s), negative backwards
  // driver-facing state
  readonly gear: number;             // -1 = reverse, 0 = neutral (manual box only), 1.. forward
  readonly rpm: number; readonly steer: number; readonly throttle: number; readonly brake: number;   // steer: front wheel angle (rad)
  tc: boolean; manual: boolean;      // traction control; manual gearbox
  assist: boolean;                   // countersteer assist (the setting; cars without one ignore it)
  pendingShift: number;              // manual shifts queued by the player (+ up, - down), taken one per tick
  shiftDenied: boolean;              // set when a manual downshift was refused (it would over-rev); the game clears it
  forceSurface?: number;             // testing: pretend every wheel is on this surface
  readonly tipped: number;           // seconds spent on its side or roof at walking pace (needsReset puts it back)
  // Instruments (the cockpit display shows what a car has; undefined: the car has none)
  readonly tcActive: boolean; readonly absActive: boolean;   // traction control / ABS cut in during the last tick
  readonly battery?: number;         // energy store charge, 0..1 (hybrids)
  readonly flapsOpen?: boolean;      // movable wings open (cars that have them)
  readonly tyres?: VehicleTyres;     // tyre temperatures and pressures (cars whose physics models them)

  step(dt: number, input: DriveInput): void;   // before world.step(): apply this tick's forces
  readState(): void;                 // after world.step(): refresh the physics state above
  // On the track at (s, lat) facing the racing direction (turned `heading` rad to the left of it, rolling along its
  // nose), stopped or already rolling at `speed` (m/s) in the gear for it; state refreshed and prev = current.
  placeAt(s: number, lat?: number, speed?: number, heading?: number): void;
  destroy(): void;                   // leave the world and the scene, and free its body (mesh.dispose)
  render(alpha: number, dt: number): void;  // pose the mesh between prev and current state
}
