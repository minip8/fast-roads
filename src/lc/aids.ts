import * as THREE from 'three';
import { compoundData, DEFAULT_FRICTION_LIMIT_ANGLE_DEG, type TyresCompoundData } from './vendor/sim/f12026-car/F12026CarConfig';
import type { VehiclePhysics } from './vendor/sim/f12026-car/VehiclePhysics';

// ============================================================================
// Traction control and ABS for LibreCorsa-engine cars. Ported from LibreCorsa's game adapter
// (src/lib/sim/f12026-car/F12026CarSim.ts at commit c31ac20, MIT), which the vendored engine does not include: the
// engine itself locks all four wheels on a full brake pedal and spins the rears on a full throttle.
//
// Runs once per 2 ms engine step (VehiclePhysics.FIXED_DT): update() right before vehicle.step(), afterStep() right
// after it. The "130 Hz" TC and "240 Hz" ABS are filter bandwidths, cut += (want - cut) * min(1, rate * h): at the
// game's 120 Hz tick the min(1, ...) saturates and both become on/off switches.
// ============================================================================
const G = 9.81;
const DEG2RAD = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;

// The 12-position TC and the 4-channel ABS of one car (F12026CarSim.ts CarElectronicsProfile). The level tables run
// from the most intrusive position (index 0 = level 12) to the least (index 11 = level 1); 0 is off.
export interface CarElectronicsProfile {
  absLevels: readonly number[];      // allowed lock slip ratio per position
  absRateHz: number;
  tcLevels: readonly number[];       // allowed driven-wheel slip ratio per position
  tcRateHz: number;
  tcMinSpeedKmh: number;
  tcLateralTightening?: { gain: number; exponent: number; floor: number };   // target x max(floor, 1 - gain (|ay|/g)^exp - slide)
  tcDryRearSlide?: { gain: number; from: number };   // the slide term on a dry road; absent: none
  absRearSlipAngleGuard?: { gain: number; deadbandRad: number; floor: number };
}

// Dial positions. tcLevel / absLevel 0 = off; tc2Level (1..12) sets how hard the TC cuts once it acts.
export interface AidDials { tcLevel: number; tc2Level: number; absLevel: number }

// Controller gains, F12026CarSim.ts DEFAULT_AID_CONTROL (neither car overrides them). The wet-road slide term is left
// out: we have no weather.
const TC_STAGE_A_SLIP = 0.03, TC_STAGE_A_CUT = 0.25;   // spark retard: up to 25 % over the first 0.03 of excess slip
const TC_STAGE_B_SLOPE = 1.6, TC_STAGE_B_SLOPE_TC2 = 3.2;   // cylinder cut past it, per peak slip ratio of excess
const TC_FLOOR = 0.18, TC_FLOOR_PER_TC2 = 0.011;       // torque share it never cuts below
const TC_SLIP_MAX_W = 0.65, TC_SLIP_MEAN_W = 0.35;     // driven slip: 0.65 x the faster wheel + 0.35 x the mean
const TC_RELEASE_SHARE = 0.24;                         // gives torque back at this share of its cutting rate
const ABS_GAIN = 12.5, ABS_FLOOR = 0.08;
const ABS_APPLY_SHARE = 0.65, ABS_RELEASE_SHARE = 0.16;
const ABS_ANTICIPATION_S = 0.016;                      // a wheel decelerating fast counts as this much further locked
const DEFAULT_TC_LATERAL_TIGHTENING = { gain: 0.14, exponent: 1.3, floor: 0.42 } as const;
const DEFAULT_ABS_REAR_GUARD = { gain: 1.4, deadbandRad: 0.03, floor: 0.72 } as const;

// The F1 table lives in their adapter (F12026CarSim.ts F12026_ELECTRONICS); the GT3's is AMG_GT3_ELECTRONICS in the
// vendored car data.
export const F1_ELECTRONICS: CarElectronicsProfile = {
  absLevels: [0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19],
  absRateHz: 240,
  tcLevels: [0.065, 0.07, 0.075, 0.08, 0.085, 0.09, 0.095, 0.1, 0.11, 0.12, 0.135, 0.15],
  tcRateHz: 130,
  tcMinSpeedKmh: 7.2,
};

// Their "semi_pro" preset, a new player's default (F12026CarSim.ts F1_ASSIST_DIALS; AmgGt3Sim.ts assistDials)
export const F1_DIALS: AidDials = { tcLevel: 5, tc2Level: 6, absLevel: 5 };
export const GT3_DIALS: AidDials = { tcLevel: 10, tc2Level: 6, absLevel: 9 };

// What update() hands the engine. brakeWheelScale is the same array every call.
export interface AidOutput { ignitionCut: number; brakeWheelScale: readonly [number, number, number, number] }

const _dv = new THREE.Vector3(), _ex = new THREE.Vector3();

export class Aids {
  private readonly cd: TyresCompoundData;              // the fitted compound (both cars run the soft slot)
  private tcCut = 1; private absCut = 1;
  private readonly absWheelCut: [number, number, number, number] = [1, 1, 1, 1];
  private readonly prevOmega = [0, 0, 0, 0];
  private lastAy = 0;                                  // body lateral acceleration over the last step (m/s2, + left)
  private readonly velBefore = new THREE.Vector3();
  private readonly out: AidOutput = { ignitionCut: 1, brakeWheelScale: this.absWheelCut };

  // minSpeedMs: the car profile's own TC floor (CarSimProfile.tcMinSpeedMs), on top of the table's
  constructor(private readonly v: VehiclePhysics, private readonly elec: CarElectronicsProfile, private readonly minSpeedMs: number) {
    this.cd = compoundData(v.config, v.compound);
    this.reset();
  }

  get tcActive() { return this.tcCut < 0.98; }
  get absActive() { return this.absCut < 0.98; }

  // After every placement (F12026CarSim.ts afterPlacement)
  reset() {
    this.tcCut = this.absCut = 1;
    this.absWheelCut.fill(1);
    for (let i = 0; i < 4; i++) this.prevOmega[i] = this.v.wheels[i].omega;
    this.lastAy = 0;
    this.velBefore.copy(this.v.velocity);
  }

  // One engine step's TC and ABS (F12026CarSim.ts electronicAids). The pedals themselves pass through: the TC acts on
  // ignitionCut, which takes torque off at once, and the ABS on per-wheel brake pressure. brake: this step's pedal.
  update(brake: number, h: number, dials: AidDials): AidOutput {
    const v = this.v, W = v.wheels, speed = v.speedMs, elec = this.elec, cd = this.cd;
    this.velBefore.copy(v.velocity);

    // TC: a slip target tightened by lateral g (and on the GT3 by the rears' slide), then a two-stage cut
    const tcLv = clamp(Math.round(dials.tcLevel), 0, 12);
    const tcBase = tcLv > 0 ? elec.tcLevels[clamp(12 - tcLv, 0, elec.tcLevels.length - 1)] : 0;
    if (tcBase > 0 && speed > Math.max(this.minSpeedMs, elec.tcMinSpeedKmh / 3.6)) {
      const tight = elec.tcLateralTightening ?? DEFAULT_TC_LATERAL_TIGHTENING;
      const gLat = Math.abs(this.lastAy) / G;
      const saLimit = Math.max(0.05, (cd.modelData.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD);
      const [dl, dr] = v.drivenWheels;
      const saDriven = Math.max(Math.abs(W[dl].slipAngleRad), Math.abs(W[dr].slipAngleRad)) / saLimit;
      const slide = elec.tcDryRearSlide;
      const slideTerm = slide ? slide.gain * Math.max(0, saDriven - slide.from) : 0;
      const target = tcBase * Math.max(tight.floor, 1 - tight.gain * Math.pow(gLat, tight.exponent) - slideTerm);
      const axleSlip = (l: number, r: number) => {
        const kL = Math.max(0, W[l].slipRatio), kR = Math.max(0, W[r].slipRatio);
        return TC_SLIP_MAX_W * Math.max(kL, kR) + TC_SLIP_MEAN_W * 0.5 * (kL + kR);
      };
      let k = axleSlip(dl, dr);
      if (v.coupledWheels) k = Math.max(k, axleSlip(v.coupledWheels[0], v.coupledWheels[1]));
      const e = Math.max(0, k - target);
      const tc2 = clamp(dials.tc2Level, 1, 12), tc2n = (tc2 - 1) / 11;
      const cutA = Math.min(1, e / TC_STAGE_A_SLIP) * TC_STAGE_A_CUT * (0.55 + 0.45 * tc2n);
      const peak = Math.max(0.05, cd.modelData.slip_ratio_limit);
      const cutB = e > TC_STAGE_A_SLIP ? ((e - TC_STAGE_A_SLIP) / peak) * (TC_STAGE_B_SLOPE + TC_STAGE_B_SLOPE_TC2 * tc2n) : 0;
      const want = e > 0 ? Math.max(Math.max(0.05, TC_FLOOR - TC_FLOOR_PER_TC2 * tc2), 1 - cutA - cutB) : 1;
      const rate = want < this.tcCut ? elec.tcRateHz : elec.tcRateHz * TC_RELEASE_SHARE;
      this.tcCut += (want - this.tcCut) * Math.min(1, rate * h);
    } else this.tcCut = 1;

    // ABS, per wheel: slip ratio plus a look-ahead on the wheel's deceleration; the rears' target tightens with their
    // slip angle so trail braking does not step the tail out
    const absLv = clamp(Math.round(dials.absLevel), 0, 12);
    const absBase = absLv > 0 ? elec.absLevels[clamp(12 - absLv, 0, elec.absLevels.length - 1)] : 0;
    const cut = this.absWheelCut;
    if (this.absCut === 1) cut.fill(1);
    if (absBase > 0 && speed > 3 && brake > 0.01) {
      const guard = elec.absRearSlipAngleGuard ?? DEFAULT_ABS_REAR_GUARD, rate = elec.absRateHz;
      let minCut = 1;
      for (let i = 0; i < 4; i++) {
        const w = W[i];
        const wheelDecel = Math.max(0, -(w.omega - this.prevOmega[i]) / Math.max(1e-4, h));
        const lock = -w.slipRatio + ((wheelDecel * w.rollingRadius) / Math.max(8, speed)) * ABS_ANTICIPATION_S;
        const rearGuard = i >= 2 ? Math.max(guard.floor, 1 - guard.gain * Math.max(0, Math.abs(w.slipAngleRad) - guard.deadbandRad)) : 1;
        const target = absBase * rearGuard;
        const want = lock > target ? Math.max(ABS_FLOOR, 1 - (lock - target) * ABS_GAIN) : 1;
        cut[i] += (want - cut[i]) * Math.min(1, (want < cut[i] ? rate * ABS_APPLY_SHARE : rate * ABS_RELEASE_SHARE) * h);
        minCut = Math.min(minCut, cut[i]);
      }
      this.absCut = minCut;
    } else {
      this.absCut = 1;
      cut.fill(1);
    }
    for (let i = 0; i < 4; i++) this.prevOmega[i] = W[i].omega;
    this.out.ignitionCut = this.tcCut;
    return this.out;
  }

  // The lateral acceleration the next step's TC tightening reads, over the time the step really advanced
  // (F12026CarSim.ts step loop). Body +x is the car's left.
  afterStep() {
    const v = this.v, dt = v.lastStepTimeS;
    if (dt > 0) this.lastAy = _dv.subVectors(v.velocity, this.velBefore).dot(_ex.set(1, 0, 0).applyQuaternion(v.quaternion)) / dt;
  }
}
