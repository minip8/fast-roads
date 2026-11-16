import type * as THREE from 'three';
import type { CarMesh } from './carMeshes';
import type { CarInfo } from './cars';
import type { TrackPos } from './track';

// ============================================================================
// Vehicle: a drivable car as the rest of the game sees it (session, timing, camera, HUD, dust, sound, autopilot),
// whichever physics engine drives it. Car (car.ts) is ours; createVehicle (sim.ts) picks the engine from the spec.
// ============================================================================

// s a manual downshift that would over-rev the engine waits for the revs to come down before it is refused: pressed
// a moment early under braking, it goes in as soon as the gear fits.
export const SHIFT_HOLD = 0.8;

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
  readonly slip: number;             // slip amount, about 1.15 at the tyre's peak (tyre sound)
  readonly contact: { readonly x: number; readonly y: number; readonly z: number };   // contact point while grounded (dust)
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
  shiftDenied: boolean;              // set when a manual downshift was refused (still over-revving after SHIFT_HOLD); the game clears it
  forceSurface?: number;             // testing: pretend every wheel is on this surface
  readonly tipped: number;           // seconds spent on its side or roof at walking pace (needsReset puts it back)

  step(dt: number, input: DriveInput): void;   // before world.step(): apply this tick's forces
  readState(): void;                 // after world.step(): refresh the physics state above
  // On the track at (s, lat) facing the racing direction, stopped or already rolling at `speed` (m/s) in the gear
  // for it; state refreshed and prev = current.
  placeAt(s: number, lat?: number, speed?: number): void;
  destroy(): void;                   // leave the world and the scene, and free its body (mesh.dispose)
  render(alpha: number, dt: number): void;  // pose the mesh between prev and current state
}
