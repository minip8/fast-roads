import type { DriveInput } from '../vehicle';
import type { VehicleInputs, VehiclePhysics } from './vendor/sim/f12026-car/VehiclePhysics';

// ============================================================================
// What sits between the game's DriveInput and the LibreCorsa engine's VehicleInputs for one car: pedal ramps for
// keys, steering shaping per device, traction control and ABS. LibreCorsa's engine has none of these itself (full
// brake pedal simply locks the wheels); its game adapter supplies them, 500 times a second. LcCar (lcCar.ts) owns
// the gearbox (shifts, reverse) and the flaps, and calls a driver in this order each 120 Hz game tick:
//
//   frame(dt, input, tc)                 once: this tick's input, already swapped for reverse by LcCar
//   for each 2 ms engine tick:
//     inputs(h, out)                     fill out.throttle / brake / steer / ignitionCut / brakeWheelScale
//     vehicle.step(h, out)
//     afterStep(h)                       measure what the aids need from the step just taken
// ============================================================================
export interface EngineDriver {
  reset(): void;                                              // the car was placed somewhere: forget filters and aid state
  frame(dt: number, input: DriveInput, tc: boolean): void;    // tc: the player's traction control setting
  inputs(h: number, out: VehicleInputs): void;                // steer is the engine's: -1..1, + = right
  afterStep(h: number): void;
}

// Builds a car's driver around its engine instance (a car spec carries one of these).
export type EngineDriverFactory = (vehicle: VehiclePhysics) => EngineDriver;
