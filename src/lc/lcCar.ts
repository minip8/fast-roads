import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { S_ASPHALT } from '../config';
import { type CarMesh, poseCockpit } from '../carMeshes';
import type { LcSpec } from '../cars';
import { pointAt, projectOnTrack, surfaceAt, trackLimitOut, type SurfaceRes, type Track, type TrackPos } from '../track';
import { SHIFT_HOLD, type DriveInput, type Vehicle, type VehicleWheel } from '../vehicle';
import type { EngineDriver } from './engineDriver';
import { trackGround, trackWalls } from './ground';
import { VehiclePhysics, type VehicleInputs } from './vendor/sim/f12026-car/VehiclePhysics';

// ============================================================================
// A car on LibreCorsa's engine (src/lc/vendor), as the game sees any car. The engine runs its own fixed 500 Hz
// steps; each 120 Hz game tick runs four or five of them, with the spec's driver (pedals, steering, aids) around
// each one. This class owns the gearbox in our conventions (reverse on the brake at a standstill, queued manual
// shifts, a neutral the engine's box does not have), the 2026 F1's flaps, and turning the engine's state into ours.
// ============================================================================
const H = VehiclePhysics.FIXED_DT;
const SLIP_PEAK = 1.15;   // our tyre sound's slip at the grip peak; the engine's combinedSlip is 1 there
const SLIP_MAX = 4;       // ...and runs to thousands on a locked wheel: kept to a few times the peak

// 2026 Straight Mode windows (lap fractions): LibreCorsa's rule, every stretch of at least 250 m whose curvature
// stays within 1/800 m (straight-mode-zones.ts), on our smoothed curvature.
const windows = new WeakMap<Track, { start: number; end: number }[]>();
export function straightWindows(tr: Track): readonly { start: number; end: number }[] {
  let out = windows.get(tr);
  if (out) return out;
  out = [];
  const straight = (i: number) => Math.abs(tr.KS[i % tr.N]) <= 1 / 800, first = tr.KS.findIndex((k) => Math.abs(k) > 1 / 800);
  if (first < 0) out.push({ start: 0, end: 1 });
  else for (let q = 1; q <= tr.N;) {
    if (!straight(first + q)) { q++; continue; }
    const from = q;
    while (q <= tr.N && straight(first + q)) q++;
    const a = tr.S[(first + from) % tr.N], b = tr.S[(first + q - 1) % tr.N];
    if ((b >= a ? b - a : b - a + tr.L) >= 250) out.push({ start: a / tr.L, end: b / tr.L });
  }
  windows.set(tr, out);
  return out;
}

class LcWheel implements VehicleWheel {
  grounded = false; surf = S_ASPHALT; out = false; slip = 0;
  readonly contact = new THREE.Vector3();
  readonly proj: TrackPos = { i: -1, s: 0, lat: 0 };
  readonly sres: SurfaceRes = { surf: 0, h: 0 };
}

export class LcCar implements Vehicle {
  readonly wheels = [new LcWheel(), new LcWheel(), new LcWheel(), new LcWheel()];
  readonly mesh: CarMesh;
  vehicle!: VehiclePhysics;                 // replaced on a spawn (placeAt on the grid): read it at call time
  private driver!: EngineDriver;
  // driver-facing state
  gear = 1; rpm = 0; steer = 0; throttle = 0; brake = 0;
  tc = true; manual = false; assist = false;
  pendingShift = 0; shiftDenied = false;
  forceSurface?: number;
  tipped = 0;
  private barriers = true;                  // the engine meets the track's barriers (tests may take them away)
  private revTimer = 0;                     // s the brake has been held at a standstill (reverse after 0.35)
  private shiftBusy = 0;                    // s until the engine has finished the manual shift under way
  private shiftHold = 0;                    // s a downshift has waited for the revs to come down (SHIFT_HOLD)
  private neutral = false;                  // our neutral: the engine's box has none, so its clutch is held open
  private flapAsked = false;                // the last engine step asked for the flaps (the engine acts on the rising edge)
  private ticks = 0;                        // engine steps owed, in 1/(game tick rate) units of a second
  private groundFor?: number;               // the forceSurface the engine's ground was built for
  private spawnS?: number;                  // where the first placement put the car: placing it there again is a spawn
  private progressI = -1;                   // locateProgress's search hint
  private readonly progress: TrackPos = { i: -1, s: 0, lat: 0 };
  private readonly inp: VehicleInputs = { throttle: 0, brake: 0, steer: 0 };
  private readonly swapped: DriveInput = { throttle: 0, brake: 0, steer: 0, analog: false };
  // physics state, refreshed by readState()
  proj: TrackPos = { i: -1, lat: 0, s: 0 };
  pos = new THREE.Vector3(); quat = new THREE.Quaternion(); vel = new THREE.Vector3(); angv = new THREE.Vector3();
  up = new THREE.Vector3(); fwd = new THREE.Vector3(); left = new THREE.Vector3();
  prevPos = new THREE.Vector3(); prevQuat = new THREE.Quaternion();
  speedF = 0;

  // The Rapier world is not used: the engine has its own body, and meets our walls through trackWalls.
  constructor(_world: RAPIER.World, readonly track: Track, readonly scene: THREE.Scene, readonly spec: LcSpec) {
    this.build();
    this.mesh = spec.mesh(spec);
    scene.add(this.mesh.root);
  }

  // A new engine instance, as the car leaves the garage: fuel, full battery, tyres in their blankets, discs at their
  // start temperature. Not yet placed.
  private build() {
    const sp = this.spec, tr = this.track;
    const v = new VehiclePhysics({
      ground: trackGround(tr, this.forceSurface), walls: this.barriers ? trackWalls(tr) : undefined,
      config: structuredClone(sp.config), compound: sp.config.compoundSlots.soft, performanceMode: 'RAC',
      airDensity: sp.rho, ambientC: 27,
      drsZones: [], straightZones: sp.straightMode ? straightWindows(tr) : [],
      // lap progress: the per-lap energy allowances reset when it wraps, and the straights are found by it
      locateProgress: (x, z) => {
        if (!Number.isFinite(x + z)) return Number.NaN;
        this.progressI = projectOnTrack(tr, x, z, this.progressI, this.progress).i;
        return this.progress.s / tr.L;
      },
    });
    v.turbocharged = sp.turbo;
    v.drsFitted = sp.straightMode;          // VehiclePhysics fits flaps by default; the GT3 has none
    v.drsFlaps = 'front-rear';
    v.drsGatedByDetection = false;          // 2026: every straight, no detection point (gated, the windows never open)
    v.realism = { tyreWearScale: 0, thermalGripScale: 1, fuelUse: false, wetSeverity: 1 };
    v.setFuelMass(sp.fuelKg);
    v.refreshStaticGeometry();              // spring preloads for that load
    this.vehicle = v;
    this.groundFor = this.forceSurface;
    this.driver = sp.driver(v);
  }

  // Testing: without barriers, as a session whose Rapier walls were removed.
  setBarriers(on: boolean) {
    this.barriers = on;
    this.vehicle.setWalls(on ? trackWalls(this.track) : undefined);
  }

  destroy() {
    this.scene.remove(this.mesh.root);
    this.mesh.dispose();
  }

  // At (s, lat), facing the racing direction, at rest or rolling at `speed` (the engine's rolling start: settled
  // with the aero load on the springs, in the gear for the speed, turbo spooled). Placing the car where it was first
  // placed (the start spot: the session puts it there to start and on every restart) is a spawn, a fresh car as from
  // the garage, whose settle the engine has usually done before (its settle memo). Anywhere else (the tests) the same
  // car is put back, with its fuel, battery and lap energy, on fresh tyres and brakes. At rest that settle is new
  // every time, so it is the engine's rolling one at 1 mm/s: a third of the cost, because it skips the 1.2 s on the
  // brakes that winds the tyres up against a slope, and our ground is flat.
  placeAt(s: number, lat = 0, speed = 0) {
    const tr = this.track, p = pointAt(tr, s, lat);
    let spawn = this.spawnS === undefined;
    if (spawn) this.spawnS = s;
    else if (s === this.spawnS && lat === 0) { this.build(); spawn = true; }
    if (this.groundFor !== this.forceSurface) { this.vehicle.setGround(trackGround(tr, this.forceSurface)); this.groundFor = this.forceSurface; }
    this.vehicle.reset(p.x, p.z, Math.atan2(tr.TX[p.i], tr.TZ[p.i]), speed > 0 ? speed : spawn ? 0 : 1e-3, false);
    this.driver.reset();
    this.revTimer = 0; this.shiftBusy = this.shiftHold = 0; this.neutral = false; this.flapAsked = false; this.tipped = 0; this.ticks = 0; this.progressI = -1;
    this.throttle = this.brake = 0;
    this.readState();
    this.proj.i = -1;
    projectOnTrack(tr, this.pos.x, this.pos.z, -1, this.proj);
    this.refresh();
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
  }

  readState() {
    const v = this.vehicle;
    if (!v.stateIsSane()) return;           // blown up: keep the last good state for timing, camera and the reset
    this.pos.copy(v.position); this.quat.copy(v.quaternion);
    this.vel.copy(v.velocity); this.angv.copy(v.angularVelocity);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);     // the engine's body axes are ours: x left, y up, z forward
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.left.set(1, 0, 0).applyQuaternion(this.quat);
    this.speedF = this.vel.dot(this.fwd);
  }

  step(dt: number, input: DriveInput) {
    const v = this.vehicle, tr = this.track;
    this.readState();
    if (!v.stateIsSane()) { this.tipped = Infinity; return; }   // blown up: needsReset puts it back on track
    projectOnTrack(tr, this.pos.x, this.pos.z, this.proj.i, this.proj);
    const vF = this.speedF;
    this.tipped = this.up.y < 0.3 && this.vel.length() < 2 ? this.tipped + dt : 0;
    if (this.groundFor !== this.forceSurface) { v.setGround(trackGround(tr, this.forceSurface)); this.groundFor = this.forceSurface; }

    // --- gearbox, as Car's: one engine paddle (+1 up, -1 down) at most this tick. The engine's automatic box never
    // enters or leaves reverse (its -1), so that is done with the paddles in either mode.
    const autoBox = !this.manual || !!input.autoGears, g = v.gear, top = this.spec.config.gearbox.ratios.length;
    v.autoShift = autoBox;
    if (autoBox) this.neutral = false;      // the automatic box has no neutral
    let shift = 0;
    if (this.neutral) {
      // Neutral is the clutch held open (below) with the engine's box in a forward gear: first out of reverse, and
      // up through the gears while the road speed would over-rev the one it is in, so that leaving neutral fits.
      this.revTimer = 0;
      if (g === -1 || (g < top && this.overRevs(g))) shift = 1;
    } else if (g === -1) {
      if (input.throttle > 0.1 && vF > -1) shift = 1;
      this.revTimer = 0;
    } else if (Math.abs(vF) < 0.6 && input.brake > 0.5 && input.throttle < 0.05) {
      this.revTimer += dt;
      if (this.revTimer > 0.35) shift = -1;   // down a gear a tick until reverse (a shift under way queues the next)
    } else this.revTimer = 0;
    // Manual shifts wait for the one under way: the engine keeps a single paddle press while it shifts, so presses
    // sent meanwhile would replace each other (three quick presses gave two gears).
    this.shiftBusy = Math.max(0, this.shiftBusy - dt);
    if (!autoBox && this.pendingShift !== 0 && shift === 0 && this.shiftBusy <= 0) {
      // One press: reverse, neutral, first... A press that cannot be taken yet is held (the box in neutral still
      // finding its gear; a downshift that would over-rev, for up to SHIFT_HOLD before it is refused).
      const dir = Math.sign(this.pendingShift);
      let held = false;
      if (this.neutral) {
        if (dir > 0) { if (g >= 1 && !this.overRevs(g)) this.neutral = false; else held = true; }
        else if (Math.abs(vF) < 1) { shift = -1; if (g === 1) this.neutral = false; else held = true; }   // reverse, only at a standstill
      } else if (dir > 0) {
        if (g === -1) { this.neutral = true; shift = 1; }
        else if (g < top) shift = 1;
      } else if (g > 1) {
        if (!this.overRevs(g - 1)) shift = -1;
        else if ((this.shiftHold += dt) > SHIFT_HOLD) { this.pendingShift = 0; this.shiftDenied = true; }
        else held = true;
      } else if (g === 1) this.neutral = true;   // at any speed
      if (!held) { this.pendingShift -= Math.sign(this.pendingShift); this.shiftHold = 0; }
    }
    if (autoBox) { this.pendingShift = 0; this.shiftHold = 0; }
    if (shift !== 0) { const gb = this.spec.config.gearbox; this.shiftBusy = shift < 0 ? gb.downshiftTimeS ?? gb.shiftTimeS : gb.shiftTimeS; }
    // In reverse the brake pedal drives backwards and the throttle brakes. The pedals swap only while the engine is
    // in reverse: on the way in (the downshift from first can take 0.1 s) the brake stays the brake, and on the way
    // out the throttle waits for first gear instead of driving backwards.
    let inp = input;
    if (g === -1 && !this.neutral) {
      inp = Object.assign(this.swapped, input);
      inp.throttle = shift > 0 ? 0 : input.brake; inp.brake = shift > 0 ? 0 : input.throttle;
    }

    // --- the engine's fixed steps owed this tick, counted in whole units so they never drift (dt is 1/120 s)
    const tickHz = Math.round(1 / dt), stepHz = Math.round(1 / H);
    this.ticks += stepHz;
    const n = Math.floor(this.ticks / tickHz);
    this.ticks -= n * tickHz;
    this.driver.frame(dt, inp, this.tc);
    const out = this.inp;
    for (let k = 0; k < n; k++) {
      this.driver.inputs(H, out);
      out.shiftUp = k === 0 && shift > 0;
      out.shiftDown = k === 0 && shift < 0;
      if (this.neutral) out.clutch = 1; else if (out.clutch !== undefined) out.clutch = undefined;
      // Their autopilot's flap rule, so the flaps work themselves: ask whenever they may open and the foot is down.
      // The engine acts on the request's rising edge and refuses it while the brake is touched, so the request is
      // dropped every other step and made again: held, one refusal kept the flaps shut for the rest of the straight.
      out.drs = this.flapAsked = !this.flapAsked && this.spec.straightMode && v.telemetry.drsAvailable && !v.drsOpen && out.throttle > 0.95;
      v.step(H, out);
      this.driver.afterStep(H);
    }
    if (!v.stateIsSane()) this.tipped = Infinity;   // blown up within this tick: reset before anything renders it
    this.throttle = out.throttle; this.brake = out.brake;
    this.refresh();
  }

  // Whether a downshift into gear `to` would be refused: the engine's own test (requestShift), road rpm over the
  // redline plus the box's margin, so a press can wait for the gear to fit instead of being sent and lost.
  private overRevs(to: number) {
    const v = this.vehicle, gb = this.spec.config.gearbox, [dl, dr] = v.drivenWheels;
    const r = Math.max(0.2, 0.5 * (v.wheels[dl].rollingRadius + v.wheels[dr].rollingRadius) || 0.35);
    const roadRpm = (Math.abs(this.speedF) / r) * gb.ratios[to - 1] * gb.finalDrive * 60 / (2 * Math.PI);
    return roadRpm > gb.gears.redline_rpm + (gb.downshift?.overRevRpm ?? -200);
  }

  // Our view of the engine's driver-facing and wheel state after a tick.
  private refresh() {
    const v = this.vehicle, tr = this.track, W = v.wheels;
    this.gear = this.neutral ? 0 : v.gear;   // the engine's numbers are ours: -1 reverse, 1.. forward
    this.rpm = v.rpm;
    this.steer = 0.5 * (W[0].steerRad + W[1].steerRad);
    for (let k = 0; k < 4; k++) {
      const w = this.wheels[k], e = W[k], hp = e.hardpointWorld;
      w.grounded = e.grounded;
      w.contact.set(hp.x, e.ground.height, hp.z);
      projectOnTrack(tr, hp.x, hp.z, this.proj.i, w.proj);
      surfaceAt(tr, w.proj.i, w.proj.lat, w.proj.s, w.sres);
      w.surf = this.forceSurface ?? w.sres.surf;
      w.out = trackLimitOut(tr, w.proj.i, w.proj.lat);
      w.slip = e.grounded ? Math.min(SLIP_MAX, e.combinedSlip * SLIP_PEAK) : 0;
    }
  }

  render(alpha: number) {
    const m = this.mesh, W = this.vehicle.wheels;
    m.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    m.root.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
    for (let k = 0; k < 4; k++) {
      const e = W[k], wm = m.wheels[k];
      // the hub sits staticHubDist below the hardpoint at rest, less the suspension's compression
      wm.pivot.position.set(e.hardpoint.x, e.hardpoint.y - (e.staticHubDist - e.compression), e.hardpoint.z);
      wm.pivot.rotation.y = e.steerRad;
      wm.spinner.rotation.x = e.rotationRad;
    }
    poseCockpit(m.cockpit, this.steer);
    m.brakeLight.material.emissiveIntensity = this.brake > 0.1 ? 3 : 0.4;
  }
}
