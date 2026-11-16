import * as THREE from 'three';
import { compoundData, DEFAULT_FRICTION_LIMIT_ANGLE_DEG } from './vendor/sim/f12026-car/F12026CarConfig';
import type { VehiclePhysics } from './vendor/sim/f12026-car/VehiclePhysics';

// ============================================================================
// Input shaping for LibreCorsa-engine cars, ported from LibreCorsa at commit c31ac20 (MIT): their keyboard steering
// assist, the rack-rate limit every non-wheel device gets, and the key pedal ramps with the throttle's slip help.
// Their keyboard assist is adapted from AC-Advanced-Gamepad-Assist v1.5.5 by Adam D. (MIT, Copyright (c) 2023
// Adam D.; github.com/adam10603/AC-Advanced-Gamepad-Assist; the notice is in README.md, Credits).
// Sign conventions are the engine's: steer + = right, yaw rate + = right; body +x is the car's LEFT, +z its nose.
// ============================================================================
const G = 9.81;
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpInvSat = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const signedPow = (x: number, y: number) => Math.sign(x) * Math.pow(Math.abs(x), y);
const approach = (v: number, target: number, maxStep: number) => v + clamp(target - v, -maxStep, maxStep);

// A car's keyboard steering: how fast a held key steers in at low and at high speed, and lets go, relative to the
// base ramp (src/lib/input/keyboard-steer.ts KeyboardSteerProfile). The curve blends between 60 and 200 km/h.
export interface KeyboardSteerProfile { lowSpeedRate: number; highSpeedRate: number; returnRate: number }
const KB_LOW_SPEED_MS = 60 / 3.6, KB_HIGH_SPEED_MS = 200 / 3.6;
function keyboardSteerSpeedRate(p: KeyboardSteerProfile, speed: number) {
  if (p.lowSpeedRate === p.highSpeedRate) return p.lowSpeedRate;
  const u = clamp01((speed - KB_LOW_SPEED_MS) / (KB_HIGH_SPEED_MS - KB_LOW_SPEED_MS));
  return p.lowSpeedRate * Math.pow(p.highSpeedRate / p.lowSpeedRate, u * u * (3 - 2 * u));
}

// ----------------------------------------------------------------------------
// Keyboard steering assist (src/lib/sim/steering-assist.ts SteeringAssist, keyboard path only). A key is all or
// nothing, so it does not go to the rack: its direction ramps along an S-curve to the angle that holds the fronts just
// under their peak slip, the wheels follow the rear axle's travel (self-steer plus yaw damping, so a released key
// straightens the car and a slide is caught), and a yaw-rate guard and a slide catch keep a held key from spinning it.
// ----------------------------------------------------------------------------

// The keyboard's coefficients at their default sliders (steering-assist.ts deviceAssistTuning, every slider 0.5,
// margin 0, countersteer cap 25 deg; the player's ramp-time scales at 1)
const KB_RATE_INCREASE_WITH_SPEED = -0.25;   // a held key steers in more slowly at speed
const KB_SELF_STEER_RESPONSE = 0.37;
const KB_DAMPING = 0.37;
const KB_MAX_SELF_STEER_DEG = 25;
const KB_MAX_LIMIT_REDUCTION = 5;
const KB_COUNTERSTEER_RESPONSE = 0.2;
const KB_TARGET_SLIP = 0.95;                 // share of the fronts' peak slip angle the limit holds
const KEYBOARD_RATE = 0.5;

// Clamp with quadratic easing into the bounds over `window` (a share of the range)
function clampEased(v: number, lo: number, hi: number, window: number) {
  const w = window * (hi - lo), half = w * 0.5;
  if (v < lo - half) return lo;
  if (v > hi + half) return hi;
  if (v < lo + half) { const t = (v - (lo - half)) / w; return lo + t * t * half; }
  if (v > hi - half) { const t = (v - (hi - half) - w) / w; return hi - t * t * half; }
  return v;
}

// Moves toward a target at a rate proportional to the distance left, blended with a constant rate by `linearity`
// (1 = linear). Rates are per second over the range.
class SmoothTowards {
  state: number;
  private readonly range: number;
  constructor(private readonly rate: number, private readonly linearity: number, min: number, max: number, private readonly start: number) {
    this.range = max - min; this.state = start;
  }
  get(target: number, dt: number, rateMult = 1) {
    const lin2 = this.linearity * this.linearity;
    const rate = ((this.rate * rateMult) / (1 - 1 / (lin2 + 1 / 0.75))) * 0.5;
    const diff = Math.abs((target - this.state) / this.range);
    this.state += Math.sign(target - this.state) * Math.min(diff, dt * (diff * (1 - lin2) + lin2) * rate) * this.range;
    return this.state;
  }
  reset() { this.state = this.start; }
}

// Per-axle tyre slip, load-weighted (src/lib/sim/tyre-slip.ts axleSlip; combinedSlip is 1 at the peak)
interface AxleSlip {
  frontSlipDeg: number; frontNdSlip: number; rearNdSlip: number;
  frontSlipRatioAbs: number; frontOnRoad: boolean; frontGrounded: boolean;
}
function axleSlip(v: VehiclePhysics, out: AxleSlip) {
  const W = v.wheels;
  const load = (i: number) => (W[i].grounded ? Math.max(0, W[i].fz) : 0);
  const weighted = (a: number, b: number, wa: number, wb: number) => (wa + wb > 1e-6 ? (a * wa + b * wb) / (wa + wb) : 0.5 * (a + b));
  const lfl = load(0), lfr = load(1), lrl = load(2), lrr = load(3);
  out.frontSlipDeg = weighted(Math.abs(W[0].slipAngleRad), Math.abs(W[1].slipAngleRad), lfl, lfr) * RAD2DEG;
  out.frontNdSlip = weighted(W[0].combinedSlip, W[1].combinedSlip, lfl, lfr);
  out.rearNdSlip = weighted(W[2].combinedSlip, W[3].combinedSlip, lrl, lrr);
  out.frontSlipRatioAbs = Math.max(Math.abs(W[0].slipRatio), Math.abs(W[1].slipRatio));
  out.frontOnRoad = W[0].ground.surface === 'road' && W[1].ground.surface === 'road';
  out.frontGrounded = lfl > 1 || lfr > 1;
  return out;
}
const newAxleSlip = (): AxleSlip => ({ frontSlipDeg: 0, frontNdSlip: 0, rearNdSlip: 0, frontSlipRatioAbs: 0, frontOnRoad: true, frontGrounded: true });

// The fronts' peak slip angle, learned while cornering near the grip with no longitudinal slip, starting from the
// tyre data's (steering-assist.ts PeakSlipEstimator). Theirs survives a reset (it belongs to the tyres); ours is reset
// with the car, whose reset puts on fresh tyres anyway.
class PeakSlipEstimator {
  private readonly smoother = new SmoothTowards(0.12, 0.05, 0, 15, 0);
  private baseDeg = NaN;
  private fastLearningS = 0;
  update(baseDeg: number, s: AxleSlip, initial: number, vx: number, dt: number) {
    if (!(Math.abs(baseDeg - this.baseDeg) < 1e-6)) {
      this.baseDeg = this.smoother.state = baseDeg;
      this.fastLearningS = 0;
    }
    if (s.frontNdSlip > 0.25 && s.frontNdSlip < 1.5 && vx > 8 && s.rearNdSlip > 0.1 && s.rearNdSlip < 1.5 &&
        s.frontOnRoad && s.frontGrounded && Math.abs(initial) > 0.6 && s.frontSlipRatioAbs < 0.03) {
      let rateMult = 1;
      if (this.fastLearningS < 1.5) { this.fastLearningS += dt; rateMult = 4; }
      this.smoother.get(clamp(s.frontSlipDeg / s.frontNdSlip, 4, 14), dt, rateMult);
    }
    return this.smoother.state;
  }
  reset() { this.baseDeg = NaN; this.smoother.reset(); this.fastLearningS = 0; }
}

// Steering rate multiplier, scaled with speed by `rateIncreaseWithSpeed` (steering-assist.ts steeringRateMult)
function steeringRateMult(speed: number, lockDeg: number, rate: number, rateIncreaseWithSpeed: number) {
  const speedAdjusted = lockDeg / Math.min(65 / (Math.max(speed, 8) - 7.3) + 3.5, lockDeg);
  return Math.pow(speedAdjusted, rateIncreaseWithSpeed) * rate;
}

// Self-steer: road-wheel angle (deg) toward the side the rear axle travels to, eased into the countersteer cap
function selfSteerDeg(rearAngleDeg: number, lockDeg: number) {
  const exponent = 1 + (1 - Math.log10(10 * (KB_SELF_STEER_RESPONSE * 0.9 + 0.1)));
  const capDeg = Math.min(lockDeg, KB_MAX_SELF_STEER_DEG);
  return clampEased(signedPow(clamp(rearAngleDeg / 72, -1, 1), exponent) * 72, -capDeg, capDeg, 1);
}

export interface SteeringCar {
  keyboardSteer: KeyboardSteerProfile;
  padLateralMu: number;   // grip the yaw-rate guard assumes, per g of weight plus downforce
}

const _ex = new THREE.Vector3(), _ey = new THREE.Vector3(), _ez = new THREE.Vector3();

export class KeyboardSteering {
  private readonly keyboard = new SmoothTowards(7, 1, -1, 1, 0);
  private readonly steering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly absSteering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly selfSteer = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly limit = new SmoothTowards(11, 0.01, 0, 32, 32);
  private readonly grounded = new SmoothTowards(4, 1, 0, 1, 1);
  private readonly counterIndicator = new SmoothTowards(12, 1, 0, 1, 0);
  private readonly slideCatch = new SmoothTowards(12, 1, 0, 1, 0);
  private readonly peakSlip = new PeakSlipEstimator();
  private readonly slip = newAxleSlip();

  constructor(private readonly v: VehiclePhysics, private readonly car: SteeringCar) {}

  reset() {
    for (const s of [this.keyboard, this.steering, this.absSteering, this.selfSteer, this.limit, this.grounded, this.counterIndicator, this.slideCatch]) s.reset();
    this.peakSlip.reset();
  }

  // Keys (-1, 0, +1, + = right) to the wanted rack position (-1..1) for one engine step; brake: the step's pedal
  update(keys: number, brake: number, dt: number): number {
    const v = this.v, kbCar = this.car.keyboardSteer;
    // The car as the assist reads it (F12026CarSim.ts steeringAssistState)
    const q = v.quaternion;
    const vx = v.velocity.dot(_ez.set(0, 0, 1).applyQuaternion(q));
    const vy = v.velocity.dot(_ex.set(1, 0, 0).applyQuaternion(q));
    const yawRate = -v.angularVelocity.dot(_ey.set(0, 1, 0).applyQuaternion(q));
    const [fl, fr] = v.wheels;
    const fz = fl.fz + fr.fz;
    const frontPeakRad = fz > 0 && fl.peakSlipAngleRad > 0 && fr.peakSlipAngleRad > 0
      ? (fl.fz * fl.peakSlipAngleRad + fr.fz * fr.peakSlipAngleRad) / fz
      : (compoundData(v.config, v.compound).modelData.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD;
    const maxLateralAccel = this.car.padLateralMu * (G + v.telemetry.downforceN / v.totalMassKg);
    // The less bent front: the lightly loaded inside one slips the most and reaches its peak first
    const frontCompliance = -(Math.abs(fl.complianceRad) < Math.abs(fr.complianceRad) ? fl.complianceRad : fr.complianceRad);
    const slip = axleSlip(v, this.slip);

    const lockDeg = v.maxSteerRad * RAD2DEG;
    const wbFactor = v.wheelbaseM / 2.5;
    const speed = Math.hypot(vx, vy);

    // A linear ramp first, quicker back to centre (and through it) than out of it, at the car's own pace
    const kbDir = Math.sign(keys);
    const kbBase = steeringRateMult(speed, lockDeg, KEYBOARD_RATE, KB_RATE_INCREASE_WITH_SPEED);
    const kbIn = kbBase * keyboardSteerSpeedRate(kbCar, speed);
    const kbOut = kbBase * kbCar.returnRate;
    const kbState = this.keyboard.state;
    const kbCentring = Math.abs(kbState) - Math.sign(kbState) * kbDir > 0;
    const raw = clamp(this.keyboard.get(kbDir, dt, kbCentring ? kbOut * 1.5 : kbIn), -1, 1);

    // Then the rounded smoother: the S-curve
    const st = this.steering.state;
    const towardCentre = Math.sign(raw) !== Math.sign(st) || Math.abs(raw) < Math.abs(st);
    const rateMult = towardCentre ? kbOut : kbIn;
    // Under half rate the return to centre stays at least as quick as at half rate
    const centringRate = rateMult > 0 && rateMult < 0.5 && towardCentre ? (rateMult * 0.5 + 0.25) / rateMult : 1;
    const initial = this.steering.get(raw, dt, rateMult * centringRate);
    const absInitial = this.absSteering.get(Math.abs(raw), dt, rateMult * centringRate);

    // Axle travel directions in the body frame (deg, + = moving right)
    const avx = Math.abs(vx);
    const vRightFront = -vy + yawRate * v.cgToFrontM;
    const vRightRear = -vy - yawRate * v.cgToRearM;
    const frontAngle = Math.atan2(vRightFront, avx) * RAD2DEG;
    const rearAngle = Math.atan2(vRightRear, avx) * RAD2DEG;
    const assistFadeIn = lerpInvSat(Math.hypot(vx, vRightFront), 2 * wbFactor, 6 * wbFactor);
    const midSpeedFade = lerpInvSat(speed, 10 * wbFactor, 20 * wbFactor);
    const inputSign = Math.sign(initial);

    const peakDeg = this.peakSlip.update(frontPeakRad * RAD2DEG, slip, initial, Math.max(0, vx), dt);

    // Self-steer toward the rear axle's travel, plus yaw damping
    const frontGrounded = this.grounded.get(slip.frontGrounded ? 1 : 0, dt);
    const selfSteerStrength = Math.max(0.25, frontGrounded) * assistFadeIn;
    const damping = -yawRate * KB_DAMPING * 0.15 * (30 / lockDeg);
    const selfSteer = clamp(this.selfSteer.get(selfSteerDeg(rearAngle, lockDeg) / lockDeg + damping, dt), -2, 2) * selfSteerStrength;

    // Grip limit: the fronts just under their peak slip angle
    const targetSlipDeg = peakDeg * KB_TARGET_SLIP;
    const maxLimitReduction = lerp(targetSlipDeg * 0.4, targetSlipDeg * 0.75, clamp01(KB_MAX_LIMIT_REDUCTION / 10));
    const angleSubLimit = lerp(maxLimitReduction, maxLimitReduction * 0.9, brake);
    // The front axle's travel away from the steering direction (outward = +)
    const frontAway = clampEased(-inputSign * frontAngle, -lockDeg - 15, angleSubLimit, (angleSubLimit * 0.4) / (lockDeg + 15 + angleSubLimit));

    // Countersteering: steering toward the side the rear slides to (0 under about 2.9 deg, 1 past 11.6)
    const isCountersteering = Math.abs(initial) > 1e-6 && inputSign === Math.sign(vRightRear);
    const rawCounter = isCountersteering ? clampEased((Math.abs(rearAngle) - 4.5) / (10 - 4.5), 0, 1, 0.6) : 0;
    const returnRate = lerp(0.8, 0.3, lerpInvSat(Math.abs(frontAngle - rearAngle), 2, 10));
    const counter = this.counterIndicator.get(rawCounter, dt, rawCounter < this.counterIndicator.state ? returnRate : 1) * midSpeedFade;
    const rearToward = inputSign * rearAngle;
    const counterMult = lerp(lerpInvSat(rearToward, 0, 30) / 3 + 2 / 3, 1, KB_COUNTERSTEER_RESPONSE);
    // Yaw-rate guard: the limit shrinks by the steering the excess rotation stands for
    const maxYawRate = (1.1 * maxLateralAccel) / Math.max(5, speed);
    const yawExcessDeg = (Math.max(0, inputSign * yawRate - maxYawRate) * v.wheelbaseM * RAD2DEG) / Math.max(5, speed);
    const targetInward = targetSlipDeg - frontAway - 2.5 * yawExcessDeg;
    // Align with the rear axle's travel plus a margin, but never past the fronts' peak: on a quick flick the rear
    // still slides from the last turn and would otherwise read as a slide to catch
    const targetCounter = Math.min(targetSlipDeg * (KB_COUNTERSTEER_RESPONSE * counterMult * 0.7 + 0.1) + rearToward, targetInward);
    const complianceDeg = -inputSign * frontCompliance * RAD2DEG;
    const targetAngle = lerp(clamp(targetInward + complianceDeg, 0, lockDeg), clamp(targetCounter + complianceDeg, 0, lockDeg), counter);

    // No limit when travelling sideways or backwards
    const travelDeg = Math.atan2(vy, vx) * RAD2DEG;
    const notForward = Math.pow(Math.sin(clamp(((travelDeg * 2) / 3) * DEG2RAD, -Math.PI / 2, Math.PI / 2)), 16);
    const limit = lerp(this.limit.get(targetAngle, dt) / lockDeg, 1, notForward);

    // Slide catch: a held key cannot ease off by degrees, so when the rear slides out past its grip while the key
    // still steers into the turn, the key hands over to the self-steer (which countersteers) until the rear grips again
    const slidingOut = Math.abs(initial) > 1e-6 && inputSign !== Math.sign(vRightRear);
    const rawSlide = slidingOut ? clampEased((Math.abs(rearAngle) - peakDeg) / (0.5 * peakDeg), 0, 1, 0.6) : 0;
    const slide = this.slideCatch.get(rawSlide, dt, rawSlide < this.slideCatch.state ? 0.5 : 1) * midSpeedFade;

    const processed = clamp(initial * limit * (1 - slide) + selfSteer - absInitial * selfSteer * (1 - slide), -1, 1);
    return clamp(lerp(initial, processed, assistFadeIn), -1, 1);
  }
}

// ----------------------------------------------------------------------------
// Rack-rate limit (F12026CarSim.ts driverCommand): keys, stick and mouse alike turn the rack no faster than hands
// turn a wheel, 900 deg/s at the rim. A mouse flick otherwise reaches the tyres as a step, which snaps a car at speed.
// ----------------------------------------------------------------------------
const DRIVER_RIM_SPEED_DEG_S = 900;

export class RackRateLimiter {
  cmd = 0;                              // the rack position last sent (-1..1)
  private readonly rimLockDeg: number;  // rim angle each way at full lock: GT3 320 deg, F1 270
  constructor(v: VehiclePhysics, steerRatio: number) { this.rimLockDeg = v.config.chassis.maxRoadWheelDeg * steerRatio; }
  step(want: number, h: number) {
    const next = approach(this.cmd, clamp(want, -1, 1), (DRIVER_RIM_SPEED_DEG_S / this.rimLockDeg) * h);
    return (this.cmd = Number.isFinite(next) ? next : 0);
  }
  reset() { this.cmd = 0; }
}

// ----------------------------------------------------------------------------
// Pedals: LibreCorsa's key ramps (src/lib/drive-session.ts, KB_THROTTLE_* / KB_BRAKE_*), here for keys and mouse
// buttons alike, and the throttle's slip help (src/lib/input/keyboard-pedals.ts, tyre-slip.ts throttleSlipAllowance)
// at its default strength 0.5. The help eases a held throttle back while the rears pass their grip, so a key is usable
// with traction control off; it is off while TC is on. Theirs has a brake half for ABS off: our ABS is always on.
// ----------------------------------------------------------------------------
const THROTTLE_RISE_S = 0.25, THROTTLE_FALL_S = 0.1;
const BRAKE_RISE_S = 0.17, BRAKE_FALL_S = 0.08;
const SLIP_LOOKAHEAD_S = 0.045;   // the slip is extrapolated this far ahead from its rate of change
const SCALE_RATE = 10;            // help scale per s per unit of slip under the peak; three times that past it
const HELP_STRENGTH = 0.5;

export class Pedals {
  throttle = 0; brake = 0;
  private helpScale = 1;
  private prevSlip = NaN;
  private readonly slip = newAxleSlip();

  constructor(private readonly v: VehiclePhysics) {}

  // Once per game tick. help: the throttle's slip help is on (traction control off). Returns the throttle to send.
  update(throttle: number, brake: number, help: boolean, dt: number): number {
    this.throttle = approach(this.throttle, throttle, dt / (throttle > this.throttle ? THROTTLE_RISE_S : THROTTLE_FALL_S));
    this.brake = approach(this.brake, brake, dt / (brake > this.brake ? BRAKE_RISE_S : BRAKE_FALL_S));
    if (!help) { this.helpScale = 1; this.prevSlip = NaN; return this.throttle; }
    const v = this.v;
    const kmh = Math.max(0, v.velocity.dot(_ez.set(0, 0, 1).applyQuaternion(v.quaternion))) * 3.6;
    const minScale = Math.min(0.9, lerp(0.6, 0.8, clamp01((kmh - 40) / 120)) - (HELP_STRENGTH - 0.5) * 0.25);
    const allowance = lerp(0.25, 0.35, clamp01((kmh - 40) / 120)) + (0.5 - HELP_STRENGTH) * 0.4;
    // keyboard-pedals.ts SlipLimitedPedal: follows the tyres only while the pedal is asked for; let go, it holds while
    // the pedal falls back (a scale back at 1 would push the falling pedal up again) and is 1 once it is released
    if (throttle <= 0) {
      this.prevSlip = NaN;
      if (this.throttle <= 0) this.helpScale = 1;
    } else {
      const s = axleSlip(v, this.slip).rearNdSlip - allowance;
      const rate = Number.isFinite(this.prevSlip) && dt > 0 ? (s - this.prevSlip) / dt : 0;
      this.prevSlip = s;
      const ahead = clamp(s + SLIP_LOOKAHEAD_S * rate, 0, 2);
      this.helpScale = clamp(this.helpScale + dt * SCALE_RATE * (ahead < 1 ? 1 - ahead : 3 * (1 - ahead)), minScale, 1);
    }
    return this.throttle * this.helpScale;
  }

  // Pedals set from outside (the autopilot's), so a hand-back ramps from where they were
  hold(throttle: number, brake: number) {
    this.throttle = throttle; this.brake = brake;
    this.helpScale = 1; this.prevSlip = NaN;
  }

  reset() { this.hold(0, 0); }
}
