import { clamp } from '../util';
import type { DriveInput } from '../vehicle';
import type { EngineDriverFactory } from './engineDriver';

// Stand-in driver until the real one (pedal ramps, steering shaping, TC, ABS) lands: the pedals go straight to the
// engine, and so does the steering, flipped to the engine's sign (+ = right); an autopilot's wheel angle becomes the
// rack position that gives it. No aids: full brake locks the wheels and full throttle spins them.
export const rawDriver: EngineDriverFactory = (vehicle) => {
  let input: DriveInput = { throttle: 0, brake: 0, steer: 0, analog: false };
  return {
    reset() { input = { throttle: 0, brake: 0, steer: 0, analog: false }; },
    frame(_dt, inp) { input = inp; },
    inputs(_h, out) {
      out.throttle = input.throttle;
      out.brake = input.brake;
      out.steer = clamp(input.steerAngle != null ? -input.steerAngle / vehicle.maxSteerRad : -input.steer, -1, 1);
      out.ignitionCut = undefined;
      out.brakeWheelScale = undefined;
    },
    afterStep() {},
  };
};
