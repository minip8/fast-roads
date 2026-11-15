import type { DriveInput } from '../vehicle';
import { Aids, F1_DIALS, F1_ELECTRONICS, GT3_DIALS, type AidDials, type CarElectronicsProfile } from './aids';
import type { EngineDriver, EngineDriverFactory } from './engineDriver';
import { KeyboardSteering, Pedals, RackRateLimiter, type KeyboardSteerProfile } from './steering';
import { AMG_GT3_ELECTRONICS } from './vendor/sim/gt3/AmgGt3Config';
import type { VehicleInputs, VehiclePhysics } from './vendor/sim/f12026-car/VehiclePhysics';

// ============================================================================
// The driver of a LibreCorsa-engine car (EngineDriver): the game's DriveInput (+ steer = left) to the engine's
// VehicleInputs (+ steer = right), by device:
//   keys (analog false)       pedal ramps; LibreCorsa's keyboard steering assist, then the rack-rate limit
//   analog (mouse, gamepad)   pedal ramps (mouse buttons are keys too); input x a speed-sensitive lock, rate-limited
//   steerAngle (autopilot)    pedals as given; the angle straight to the road wheels
// ABS is always on at the car's semi_pro dial, TC at its semi_pro dial or off, for the autopilot too (LibreCorsa's
// drives through the same aids). With TC off the throttle's slip help acts on keys and analog pedals alike. Steering
// and aids run every 2 ms engine step, as LibreCorsa's adapter does: their filters are tuned for 500 Hz.
// ============================================================================

export interface DriverCar {
  electronics: CarElectronicsProfile;
  tcMinSpeedMs: number;              // the car profile's own TC floor (CarSimProfile.tcMinSpeedMs)
  dials: AidDials;                   // with TC on; TC off sets tcLevel 0
  keyboardSteer: KeyboardSteerProfile;
  padLateralMu: number;              // grip the keyboard assist's yaw-rate guard assumes
  steerRatio: number;                // rim deg per road-wheel deg, for the rack-rate limit
  // Analog steering: full deflection asks for lock / (1 + speed / halfSpeed) of full rack lock (halfSpeed in m/s),
  // never less than floor. LibreCorsa sends the mouse to the rack unscaled; with our screen-position mouse that is
  // twitchy at speed.
  analogLock: readonly [lock: number, halfSpeed: number, floor: number];
}

// Mercedes-AMG GT3: profile values from AmgGt3Sim.ts (its steerRatio is unset, so the adapter's default 12.6).
// Analog lock: the steady-cornering peak needs 0.65 of rack lock at 50 km/h, 0.41 at 80, 0.33 at 120, 0.31 at 150
// and 0.29 from 220 up (its steering flex and understeer keep the need from falling further). Full deflection asks
// 1.15-1.4 times that (most around 80 km/h), on the floor from about 150 km/h.
export const GT3_DRIVER: DriverCar = {
  electronics: AMG_GT3_ELECTRONICS,
  tcMinSpeedMs: AMG_GT3_ELECTRONICS.tcMinSpeedKmh / 3.6,
  dials: GT3_DIALS,
  keyboardSteer: { lowSpeedRate: 1.6, highSpeedRate: 1.05, returnRate: 1.1 },
  padLateralMu: 1.5,
  steerRatio: 12.6,
  analogLock: [1.6, 12, 0.35],
};

// LC26 2026 F1 car: profile values from Lc26Sim.ts (keyboard curve OPEN_WHEEL_KEYBOARD_STEER in keyboard-steer.ts).
// Analog lock: the peak needs 0.53 of rack lock at 80 km/h, 0.33 at 150, 0.27 at 220 and 0.225 at 280; full
// deflection asks 1.1-1.3 times that (full lock up to 40 km/h).
export const F1_DRIVER: DriverCar = {
  electronics: F1_ELECTRONICS,
  tcMinSpeedMs: 2,
  dials: F1_DIALS,
  keyboardSteer: { lowSpeedRate: 1.3, highSpeedRate: 0.8, returnRate: 1 },
  padLateralMu: 1.75,
  steerRatio: 14,
  analogLock: [2, 11, 0],
};

class LcDriver implements EngineDriver {
  private readonly aids: Aids;
  private readonly keys: KeyboardSteering;
  private readonly rack: RackRateLimiter;
  private readonly pedals: Pedals;
  private readonly tcOff: AidDials;
  private dials: AidDials;
  private throttle = 0; private brake = 0;   // this tick's pedals
  private steer = 0;                         // this tick's steering input, + = left
  private angle: number | null = null;       // the autopilot's road-wheel angle (rad, + = left)
  private analog = false;
  private keysEngaged = false;               // the keyboard assist steered the last step

  constructor(private readonly v: VehiclePhysics, private readonly car: DriverCar) {
    this.aids = new Aids(v, car.electronics, car.tcMinSpeedMs);
    this.keys = new KeyboardSteering(v, car);
    this.rack = new RackRateLimiter(v, car.steerRatio);
    this.pedals = new Pedals(v);
    this.dials = car.dials;
    this.tcOff = { ...car.dials, tcLevel: 0 };
  }

  reset() {
    this.aids.reset(); this.keys.reset(); this.rack.reset(); this.pedals.reset();
    this.throttle = this.brake = this.steer = 0;
    this.angle = null; this.analog = false; this.keysEngaged = false;
  }

  frame(dt: number, input: DriveInput, tc: boolean) {
    this.dials = tc ? this.car.dials : this.tcOff;
    this.steer = input.steer;
    this.analog = input.analog;
    this.angle = input.steerAngle ?? null;
    if (this.angle !== null) {
      this.pedals.hold(input.throttle, input.brake);
      this.throttle = input.throttle; this.brake = input.brake;
    } else {
      this.throttle = this.pedals.update(input.throttle, input.brake, !tc, dt);
      this.brake = this.pedals.brake;
    }
  }

  inputs(h: number, out: VehicleInputs) {
    const v = this.v;
    let steer: number;
    if (this.angle !== null) {
      steer = Math.max(-1, Math.min(1, -this.angle / v.maxSteerRad));
      this.rack.cmd = steer;   // a hand-back is rate-limited from here
    } else if (this.analog) {
      const [lock, half, floor] = this.car.analogLock;
      steer = this.rack.step(-this.steer * Math.min(1, Math.max(floor, lock / (1 + v.speedMs / half))), h);
    } else {
      if (!this.keysEngaged) this.keys.reset();   // the assist takes over from a clean state, as theirs does
      steer = this.rack.step(this.keys.update(-Math.sign(this.steer), this.brake, h), h);
    }
    this.keysEngaged = this.angle === null && !this.analog;
    const a = this.aids.update(this.brake, h, this.dials);
    out.throttle = this.throttle;
    out.brake = this.brake;
    out.steer = steer;
    out.ignitionCut = a.ignitionCut;
    out.brakeWheelScale = a.brakeWheelScale;
  }

  afterStep() { this.aids.afterStep(); }
}

export const makeDriver = (car: DriverCar): EngineDriverFactory => (v) => new LcDriver(v, car);
export const gt3Driver: EngineDriverFactory = makeDriver(GT3_DRIVER);
export const f1Driver: EngineDriverFactory = makeDriver(F1_DRIVER);
