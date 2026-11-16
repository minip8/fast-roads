import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { G_CAR, G_CARPART, G_GROUND, G_RAY, G_WALL, PLOUGH_FADE_V, PLOUGH_WHEEL_SHARE, SURF, SURF_BLEND_T, S_ASPHALT, groups } from './config';
import { type CarMesh, poseCockpit } from './carMeshes';
import type { BrushTyre, CarSpec } from './cars';
import { pointAt, projectOnTrack, surfaceAt, trackLimitOut, type SurfaceRes, type Track, type TrackPos } from './track';
import { clamp, lerp } from './util';
import type { DriveInput, Vehicle } from './vehicle';

// ============================================================================
// Car
// ============================================================================
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export type { DriveInput } from './vehicle';

export interface Wheel {
  name: string; front: boolean;
  local: THREE.Vector3;              // suspension mount, body space
  k: number;                         // spring rate
  comp: number; prevComp: number; L: number;   // compression, last tick's compression, current length
  Fz: number; grounded: boolean;
  muBlend: number; rrBlend: number; decelBlend: number;   // surface properties, eased between surfaces
  surf: number; out: boolean;        // surface index; past the track limits
  slip: number;                      // slip amount (for sound)
  comply: number;                    // steering flex: angle (rad) the cornering force has bent this wheel by
  spin: number; omega: number;       // visual rotation and angular speed
  proj: TrackPos; sres: SurfaceRes;
  contact: THREE.Vector3; normal: THREE.Vector3;
}

export function pacejka(spec: CarSpec, alpha: number, front: boolean) {
  const { B, C, E } = (front && spec.pacFront) || spec.pac!, x = B * alpha;
  return Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
}
const COMPLY_T = 0.03;   // s: steering flex follows the cornering force over this long, so the two cannot chase each other
// Brush tyre (Fiala's model, as LibreCorsa's GT3 slick uses it): share of the peak cornering force at slip
// tan(slip angle) under load Fz. A tread of elastic bristles gives 1 - (1 - s)^3 up to the peak (three times as stiff
// around the centre as a straight line to the peak), then the whole patch slides and the force eases down to `level`.
export function brush(t: BrushTyre, tanAlpha: number, Fz: number) {
  const peak = Math.tan(t.peak) * Math.max(0.25, 1 + t.peakGain * (Fz / t.fz0 - 1)), s = Math.abs(tanAlpha);
  return Math.sign(tanAlpha) * (s <= peak ? 1 - (1 - s / peak) ** 3 : t.level + (1 - t.level) / (1 + t.slope * (s - peak)));
}
export function engineTorque(spec: CarSpec, rpm: number) {
  const T = spec.torque;
  if (rpm <= T[0][0]) return T[0][1];
  for (let k = 1; k < T.length; k++) if (rpm <= T[k][0]) return lerp(T[k - 1][1], T[k][1], (rpm - T[k - 1][0]) / (T[k][0] - T[k - 1][0]));
  return 0;
}

// Our physics: a Rapier rigid body with raycast suspension and our own tyre, engine and gearbox model on top.
export class Car implements Vehicle {
  readonly world: RAPIER.World; readonly track: Track; readonly scene: THREE.Scene; readonly spec: CarSpec;
  readonly wheels: Wheel[];
  readonly body: RAPIER.RigidBody;
  readonly mesh: CarMesh;
  private readonly mountY: number;
  private readonly ray: RAPIER.Ray;
  // driver-facing state
  gear: number; rpm: number; steer = 0; throttle = 0; brake = 0;
  private steerIn = 0;                      // the driver's part of the wheel angle (steer adds the countersteer assist)
  private looseAsk = 0;                     // eased share of the rear looseness in play (see rearLoose)
  private rearSlip = 0; private slipRate = 0;   // rear slide angle (rad) and its smoothed rate, for the assist
  private lastVF = 0; private accF = 0;     // last tick's forward speed, and the smoothed forward acceleration (m/s2)
  tc = true; manual = false;                // gearbox is automatic unless manual
  assist = false;                           // countersteer assist (only cars whose spec has one); off unless the player turns it on
  pendingShift = 0; shiftDenied = false;    // queued manual shifts; set when a downshift would over-rev
  shiftTimer = 0; private revTimer = 0;
  forceSurface?: number;                    // testing: pretend every wheel is on this surface
  tipped = 0;                               // seconds spent on its side or roof at walking pace (see needsReset)
  // physics state, refreshed by readState()
  proj: TrackPos = { i: -1, lat: 0, s: 0 };
  pos = new THREE.Vector3(); quat = new THREE.Quaternion(); vel = new THREE.Vector3(); angv = new THREE.Vector3();
  up = new THREE.Vector3(); fwd = new THREE.Vector3(); left = new THREE.Vector3();
  prevPos = new THREE.Vector3(); prevQuat = new THREE.Quaternion();
  speedF = 0;

  constructor(world: RAPIER.World, track: Track, scene: THREE.Scene, spec: CarSpec) {
    this.world = world; this.track = track; this.scene = scene; this.spec = spec;
    const r = this.spec.wheelRadius;
    const staticComp = 0.025;
    this.mountY = (r - this.spec.comHeight) + (this.spec.suspLen - staticComp);
    const mk = (x: number, z: number, front: boolean, name: string): Wheel => ({
      name, front, local: new THREE.Vector3(x, this.mountY, z), k: front ? this.spec.kFront : this.spec.kRear,
      comp: staticComp, prevComp: staticComp, Fz: 0, grounded: false, L: this.spec.suspLen - staticComp,
      muBlend: SURF[S_ASPHALT].mu, rrBlend: SURF[S_ASPHALT].rr, decelBlend: 0,
      surf: S_ASPHALT, slip: 0, comply: 0, spin: 0, omega: 0, out: false, proj: { i: 0, lat: 0, s: 0 }, sres: { surf: 0, h: 0 },
      contact: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    });
    this.wheels = [
      mk(this.spec.trackHalf, this.spec.zFront, true, 'FL'), mk(-this.spec.trackHalf, this.spec.zFront, true, 'FR'),
      mk(this.spec.trackHalf, this.spec.zRear, false, 'RL'), mk(-this.spec.trackHalf, this.spec.zRear, false, 'RR'),
    ];

    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setAdditionalMassProperties(this.spec.mass, { x: 0, y: 0, z: 0 }, this.spec.inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setCanSleep(false).setCcdEnabled(true).setAngularDamping(spec.angDamp).setLinearDamping(0.0);
    this.body = world.createRigidBody(bd);
    const col = (desc: RAPIER.ColliderDesc, member: number, filter: number) => world.createCollider(desc.setDensity(0).setCollisionGroups(groups(member, filter)), this.body);
    const [hx, hy, hz, ox, oy, oz] = spec.hull;
    col(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ox, oy, oz).setFriction(0.3).setRestitution(0.1), G_CAR, G_GROUND | G_WALL);
    for (const [px, py, pz, qx, qy, qz] of spec.parts) col(RAPIER.ColliderDesc.cuboid(px, py, pz).setTranslation(qx, qy, qz).setFriction(0.2), G_CARPART, G_WALL);
    for (const w of this.wheels) col(RAPIER.ColliderDesc.ball(r).setTranslation(w.local.x * 1.05, w.local.y - w.L, w.local.z).setFriction(0.2).setRestitution(0.2), G_CARPART, G_WALL);

    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.gear = 1; this.rpm = this.spec.idle;

    this.mesh = spec.mesh(spec);
    scene.add(this.mesh.root);
  }

  destroy() {
    this.world.removeRigidBody(this.body);   // also removes its colliders
    this.scene.remove(this.mesh.root);
    this.mesh.dispose();
  }

  // Whether forward gear g would turn the engine past its over-rev limit at this road speed.
  private overRevs(g: number, vF: number) { return (this.spec.redline * Math.max(vF, 0)) / this.spec.gearTop[g] >= this.spec.overRev; }
  // The lowest forward gear that would not (leaving neutral on the move).
  private lowestGear(vF: number) {
    let g = 1;
    while (g < this.spec.gearTop.length - 1 && this.overRevs(g, vF)) g++;
    return g;
  }

  placeAt(s: number, lat = 0, speed = 0) {
    const tr = this.track, p = pointAt(tr, s, lat), i = p.i;
    const yaw = Math.atan2(tr.TX[i], tr.TZ[i]);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x: p.x, y: this.spec.comHeight + 0.03, z: p.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: tr.TX[i] * speed, y: 0, z: tr.TZ[i] * speed }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1; this.steer = this.steerIn = this.rearSlip = this.slipRate = 0; this.looseAsk = this.spec.rearLoose[2]; this.shiftTimer = 0; this.tipped = 0; this.accF = 0;
    this.lastVF = speed;
    // rolling: the gear the automatic box would be in (the lowest that is below its shift point)
    const top = this.spec.gearTop;
    while (this.gear < top.length - 1 && (this.spec.redline * speed) / top[this.gear] > this.spec.shiftPoint) this.gear++;
    this.rpm = Math.max(this.spec.idle, (this.spec.redline * speed) / top[this.gear]);
    for (const w of this.wheels) { w.comp = w.prevComp = 0.025; w.omega = speed / this.spec.wheelRadius; w.comply = 0; w.muBlend = SURF[S_ASPHALT].mu; w.rrBlend = SURF[S_ASPHALT].rr; w.decelBlend = 0; }
    this.proj.i = -1;
    this.readState();
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
  }

  readState() {
    const b = this.body, t = b.translation(), q = b.rotation(), lv = b.linvel(), av = b.angvel();
    this.pos.set(t.x, t.y, t.z); this.quat.set(q.x, q.y, q.z, q.w);
    this.vel.set(lv.x, lv.y, lv.z); this.angv.set(av.x, av.y, av.z);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.left.set(1, 0, 0).applyQuaternion(this.quat);
    this.speedF = this.vel.dot(this.fwd);
  }

  step(dt: number, inp: DriveInput) {
    const tr = this.track, b = this.body;
    this.readState();
    projectOnTrack(tr, this.pos.x, this.pos.z, this.proj.i, this.proj);
    const v = this.vel.length(), vF = this.speedF;
    this.accF += (clamp((vF - this.lastVF) / dt, -30, 30) - this.accF) * 0.3; this.lastVF = vF;
    this.tipped = this.up.y < 0.3 && v < 2 ? this.tipped + dt : 0;

    // Rear slide: the rear axle's sideways speed (m/s, positive = to the left) and the angle (rad) between where it
    // is going and where the car points.
    const vyRear = this.vel.dot(this.left) + this.angv.dot(this.up) * this.spec.zRear;
    const slide = vF > 2 ? Math.atan2(vyRear, Math.max(vF, 5)) : 0;

    // --- steering (speed-sensitive for keyboard)
    let target, counter = 1;
    if (inp.steerAngle != null) target = inp.steerAngle;
    else {
      const [lock, halfV] = inp.analog ? this.spec.steerAnalog : this.spec.steerKeys;
      target = inp.steer * lock / (1 + Math.max(0, vF) / halfV);
      // Opposite lock follows the slide: steering into a slide turns the wheels counterLock's first number times the
      // slide angle (so the lock always suits how far the tail is out), and the keys wind it on up to its second
      // number times faster. Below about 0.8 the front tyres balance the sliding rear instead of overpowering it, so
      // held opposite lock holds the slide and the throttle decides whether it grows or comes back; at 1 or more
      // the fronts drag the nose round and the slide ends at once.
      const [clPer, clRate] = this.spec.counterLock;
      if (clPer > 0 && !inp.analog && inp.steer * slide > 0) {
        // Blended in between 8 and 16 deg of slide, so ordinary changes of direction keep the normal lock.
        const w = clamp((Math.abs(slide) - 0.14) / 0.14, 0, 1);
        target = lerp(target, inp.steer * clPer * Math.abs(slide), w);
        counter = 1 + (clRate - 1) * w;
      }
    }
    target = clamp(target, -this.spec.steerLock, this.spec.steerLock);
    const rate = inp.steerAngle != null ? 6 : inp.analog ? this.spec.steerRateAnalog : (Math.abs(target) < Math.abs(this.steerIn) ? 3.2 : 2.2) * counter * this.spec.steerRateKeys / (1 + Math.max(0, vF) / 30);
    this.steerIn += clamp(target - this.steerIn, -rate * dt, rate * dt);
    // Countersteer assist (like caster): once the rear slides past fromSlip, the front wheels turn toward where the
    // car is going, so letting go of the steering catches the slide. Three parts:
    // - assist: countersteer in proportion to the slide (gain);
    // - unwind: countersteer early as the tail steps out and back off as it returns (damp x how fast the slide is
    //   changing), which stops a held countersteer whipping the car the other way;
    // - the driver's steering into the slide fades out over `span` more radians of slide, so holding the steering
    //   key settles into a slide instead of a spin.
    const [csGain, csFrom, csDamp, csSpan] = this.spec.counterSteer;
    let own = this.steerIn, assist = 0, unwind = 0;
    if (this.assist && csGain > 0 && inp.steerAngle == null && vF > 2) {
      const rearSlip = slide;
      this.slipRate += ((rearSlip - this.rearSlip) / dt - this.slipRate) * 0.25;
      this.rearSlip = rearSlip;
      const fade = clamp((vF - 2) / 4, 0, 1), over = Math.max(0, Math.abs(rearSlip) - csFrom);
      assist = csGain * Math.sign(rearSlip) * over * fade;
      unwind = csDamp * Math.sign(this.slipRate) * Math.max(0, Math.abs(this.slipRate) - 0.4) * fade;
      if (own * rearSlip < 0) own *= 1 - fade * clamp(over / csSpan, 0, 1);
    } else this.rearSlip = this.slipRate = 0;
    // A driver who countersteers too gets the larger of the two angles, not the sum, so the assist can't overcorrect.
    const both = own * assist > 0 ? Math.sign(assist) * Math.max(Math.abs(own), Math.abs(assist)) : own + assist;
    this.steer = clamp(both + unwind, -this.spec.steerLock, this.spec.steerLock);

    // --- gearbox
    let throttle = inp.throttle, brake = inp.brake;
    if (this.gear === -1) {                        // reverse
      if (throttle > 0.1 && vF > -1) this.gear = 1;
    } else if (this.gear > 0 && Math.abs(vF) < 0.6 && brake > 0.5 && throttle < 0.05) {   // not from neutral: it stays put
      this.revTimer += dt;
      if (this.revTimer > 0.35) { this.gear = -1; this.revTimer = 0; }
    } else this.revTimer = 0;
    const autoBox = !this.manual || inp.autoGears;
    if (autoBox && this.gear === 0) this.gear = this.lowestGear(vF);   // the automatic box has no neutral
    if (autoBox && this.gear > 0) {
      const g = this.gear;
      const rpmHere = (this.spec.redline * Math.max(vF, 0)) / this.spec.gearTop[g];
      if (rpmHere > this.spec.shiftPoint && g < this.spec.gearTop.length - 1 && this.shiftTimer <= 0) { this.gear++; this.shiftTimer = 0.06; }
      else if (g > 1 && vF < this.spec.gearTop[g - 1] * 0.82) { this.gear--; this.shiftTimer = 0.04; }
    }
    // manual: one queued shift per tick (E/Q or paddles)
    if (!autoBox && this.pendingShift !== 0) {
      const dir = Math.sign(this.pendingShift), g = this.gear;
      this.pendingShift -= dir;
      if (dir > 0) {
        if (g === -1) this.gear = 0;
        else if (g === 0) this.gear = this.lowestGear(vF);
        else if (g < this.spec.gearTop.length - 1) { this.gear++; this.shiftTimer = 0.06; }
      } else if (g > 1) {
        // block downshifts that would over-rev the engine
        if (!this.overRevs(g - 1, vF)) { this.gear--; this.shiftTimer = 0.04; }
        else this.shiftDenied = true;
      } else if (g === 1) this.gear = 0;                         // neutral, at any speed
      else if (g === 0 && Math.abs(vF) < 1) this.gear = -1;      // reverse, only at a standstill
    }
    if (autoBox) this.pendingShift = 0;
    this.shiftTimer -= dt;

    let drive = 0;
    if (this.gear === 0) {
      // neutral: the engine revs free of the wheels
      this.rpm = lerp(this.rpm, this.spec.idle + throttle * (this.spec.redline - this.spec.idle), throttle > 0.02 ? 0.12 : 0.04);
    } else if (this.gear === -1) {
      // reverse: the brake pedal drives backwards (fading out by reverseTop) and the throttle brakes
      const back = brake; brake = throttle; throttle = back;
      if (back > 0.02) drive = -back * this.spec.reverseForce * clamp(1 + vF / this.spec.reverseTop, 0, 1);
      else if (vF < -2) drive = this.spec.engineBrake * (this.rpm / this.spec.redline);    // engine braking
      this.rpm = lerp(this.rpm, this.spec.idle + 3000 * inp.brake, 0.1);
    } else {
      const top = this.spec.gearTop[this.gear];
      let rpm = (this.spec.redline * Math.max(vF, 0)) / top;
      const launch = clamp(1 - vF / 10, 0, 1);       // pseudo clutch slip at low speed
      rpm = Math.max(rpm, this.spec.idle + throttle * this.spec.launchRpm * launch, this.spec.idle);
      this.rpm = rpm;
      if (this.shiftTimer > 0) drive = 0;
      else if (throttle > 0.02) drive = throttle * engineTorque(this.spec, rpm) * (this.spec.redline * 2 * Math.PI / 60) / top;
      else if (vF > 2) drive = -this.spec.engineBrake * (rpm / this.spec.redline);    // engine braking
      // The engine also has to spin itself, the gearbox and the wheels up as the car gains speed: in a low gear a
      // good share of its push goes into that. They count as extra mass at the wheels (inertia x gearing squared),
      // accelerating at the rate the car did over the last few ticks.
      const [engineI, wheelI] = this.spec.rotInertia;
      if (drive > 0 && (engineI > 0 || wheelI > 0)) {
        const gearing = (this.spec.redline * 2 * Math.PI / 60) / top;   // engine rad per metre travelled
        drive = Math.max(0, drive - (engineI * gearing * gearing + wheelI / this.spec.wheelRadius ** 2) * Math.max(0, this.accF));
      }
    }
    this.throttle = throttle; this.brake = brake;

    // --- suspension: raycasts
    const up = this.up, ray = this.ray;
    for (const w of this.wheels) {
      const m = _v1.copy(w.local).applyQuaternion(this.quat).add(this.pos);
      projectOnTrack(tr, m.x, m.z, this.proj.i, w.proj);
      surfaceAt(tr, w.proj.i, w.proj.lat, w.proj.s, w.sres);
      w.surf = this.forceSurface ?? w.sres.surf;
      const sf = SURF[w.surf], kb = 1 - Math.exp(-dt / SURF_BLEND_T);
      w.muBlend += (sf.mu - w.muBlend) * kb; w.rrBlend += (sf.rr - w.rrBlend) * kb; w.decelBlend += (sf.decel - w.decelBlend) * kb;
      w.out = trackLimitOut(tr, w.proj.i, w.proj.lat);
      ray.origin.x = m.x; ray.origin.y = m.y; ray.origin.z = m.z;
      ray.dir.x = -up.x; ray.dir.y = -up.y; ray.dir.z = -up.z;
      const maxToi = this.spec.suspLen + this.spec.wheelRadius + 0.1;
      const hit = this.world.castRayAndGetNormal(ray, maxToi, true, undefined, groups(G_RAY, G_GROUND), undefined, b);
      w.grounded = false;
      w.prevComp = w.comp;
      if (hit) {
        const dist = hit.timeOfImpact - w.sres.h / Math.max(0.5, up.y);
        const L = dist - this.spec.wheelRadius;
        if (L < this.spec.suspLen) {
          w.grounded = true;
          w.L = Math.max(L, 0.0);
          w.comp = this.spec.suspLen - w.L;
          w.contact.copy(m).addScaledVector(up, -dist);
          w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        }
      }
      if (!w.grounded) { w.comp = 0; w.L = Math.min(this.spec.suspLen, (w.L ?? this.spec.suspLen) + dt * 2); }
      const compVel = clamp((w.comp - w.prevComp) / dt, -4, 4);
      let F = w.k * w.comp + this.spec.damp * compVel;
      if (w.comp > this.spec.suspLen - 0.03) F += 400000 * (w.comp - (this.spec.suspLen - 0.03));
      w.Fz = w.grounded ? Math.max(0, F) : 0;
    }
    // anti-roll bars
    const arb = (a: Wheel, c: Wheel, k: number) => {
      if (!a.grounded || !c.grounded) return;
      const f = k * (a.comp - c.comp);
      a.Fz = Math.max(0, a.Fz + f); c.Fz = Math.max(0, c.Fz - f);
    };
    arb(this.wheels[0], this.wheels[1], this.spec.arbFront);
    arb(this.wheels[2], this.wheels[3], this.spec.arbRear);

    // --- tyres
    const mc = this.spec.mass / 4;
    // Braking while steering costs the rear some grip (brakeKick = share lost at full brake + ~9 deg of steer),
    // so the tail steps out. Going straight it does nothing, so straight-line braking stays stable.
    // The rear is also loose at cornering speeds (firm at top speed) whenever the driver asks the car to rotate: on
    // the throttle, or steering into the turn (wheels turned the way the rear is not sliding). Coasting with the
    // steering straight or on opposite lock leaves only the offThrottle share of that, so lifting off and steering
    // into a slide gives the rear its grip back.
    // Past rearCatch's first angle of slide the looseness fades, gone by its second: the tail goes a long way out
    // but then digs in rather than coming all the way round.
    const [loose, looseV, looseOff, looseEase, looseSteer] = this.spec.rearLoose, [catchFrom, catchBy, catchExtra] = this.spec.rearCatch;
    const dug = clamp((Math.abs(slide) - catchFrom) / (catchBy - catchFrom), 0, 1);
    const into = clamp(Math.abs(this.steerIn) / 0.15, 0, 1) * clamp(-Math.sign(this.steerIn) * vyRear / 0.5, 0, 1);
    // The looseness is sideways only: traction in a straight line is not reduced (driveGrip is divided by it below).
    // How much of the looseness is asked for eases in and out over looseEase seconds, so the rear lets go and
    // grips up progressively instead of in a step when the throttle or the steering changes.
    const ask = looseOff + (1 - looseOff) * Math.max(clamp(throttle, 0, 1), into * looseSteer);
    this.looseAsk = looseEase > 0 ? this.looseAsk + (ask - this.looseAsk) * (1 - Math.exp(-dt / looseEase)) : ask;
    const looseK = 1 - loose * (1 - dug) * clamp(1 - Math.abs(vF) / looseV, 0, 1) * this.looseAsk;
    const rearGrip = (1 - this.spec.brakeKick * clamp(brake, 0, 1) * clamp(Math.abs(this.steerIn) / 0.15, 0, 1)) * looseK * (1 + catchExtra * dug);
    let plough = 0;
    for (const w of this.wheels) {
      if (!w.grounded) { w.slip = 0; w.omega *= 0.99; continue; }
      const n = w.normal;
      // suspension force
      b.applyImpulseAtPoint({ x: up.x * w.Fz * dt, y: up.y * w.Fz * dt, z: up.z * w.Fz * dt }, w.contact, true);

      const delta = w.front ? this.steer + w.comply : 0;
      const wf = _v2.copy(this.fwd).multiplyScalar(Math.cos(delta)).addScaledVector(this.left, Math.sin(delta));
      wf.addScaledVector(n, -wf.dot(n)).normalize();
      const ws = _v3.crossVectors(n, wf);                     // points left
      const rx = w.contact.x - this.pos.x, ry = w.contact.y - this.pos.y, rz = w.contact.z - this.pos.z;
      const av = this.angv;
      const pvx = this.vel.x + av.y * rz - av.z * ry, pvy = this.vel.y + av.z * rx - av.x * rz, pvz = this.vel.z + av.x * ry - av.y * rx;
      const vx = pvx * wf.x + pvy * wf.y + pvz * wf.z, vy = pvx * ws.x + pvy * ws.y + pvz * ws.z;

      // Ploughing resistance from grass/gravel: most goes on the CoM (after this loop) so it can't yank the car round.
      const wPlough = w.decelBlend * mc * Math.min(1, (vx / PLOUGH_FADE_V) ** 2);
      plough += wPlough * (1 - PLOUGH_WHEEL_SHARE);
      const alpha = Math.atan2(vy, Math.max(Math.abs(vx), 7));
      const bt = this.spec.brush?.[w.front ? 'front' : 'rear'];   // a brush tyre brings its own curve and load sensitivity
      const loadSens = bt ? Math.max(w.Fz / bt.fz0, 0.18) ** (bt.loadExp - 1) : clamp(1.08 - 0.08 * (w.Fz / 2000), 0.72, 1.1);
      const Fmax = w.muBlend * loadSens * w.Fz * (w.front ? this.spec.gripFront : this.spec.gripRear * rearGrip);
      let Fy = -Fmax * (bt ? brush(bt, vy / Math.max(Math.abs(vx), 7), w.Fz) : pacejka(this.spec, alpha, w.front));

      // longitudinal: drive (rear), brakes, rolling + surface drag
      let Fdrive = w.front ? 0 : drive / 2;
      const dg = w.front ? this.spec.driveGrip : this.spec.driveGrip / looseK;   // like brakeGrip, for putting power down
      if (this.tc && Fdrive > 0) Fdrive = Math.min(Fdrive, dg * Math.max(Math.sqrt(Math.max(0, Fmax * Fmax - Fy * Fy)) * 0.97 + this.spec.tcSlack * Fmax, this.spec.spinDrive * Fmax));
      // ABS: cornering force keeps priority; brakes get the grip that's left, but never less than absMin.
      // brakeGrip stretches the friction circle for braking only: the tyres stop harder than they corner.
      const bg = this.spec.brakeGrip;
      const longAvail = bg * Math.sqrt(Math.max(0, Fmax * Fmax - Fy * Fy));
      const brakeF = Math.min(brake * this.spec.brakeMax * (w.front ? this.spec.brakeFront : 1 - this.spec.brakeFront) / 2, Math.max(longAvail, this.spec.absMin * bg * Fmax));
      const resist = brakeF + w.rrBlend * w.Fz + wPlough * PLOUGH_WHEEL_SHARE;
      const Fres = -Math.sign(vx) * Math.min(resist, (mc * Math.abs(vx)) / dt);
      let Fx = Fdrive + Fres;
      const FxAsked = Fx;

      // friction circle
      const gx = Fx * vx < 0 ? bg : dg;                       // the friction circle, stretched along the wheel
      const tot = Math.hypot(Fx / gx, Fy);
      let slide = 0;
      if (tot > Fmax && tot > 0) {
        slide = tot / Fmax - 1;
        const k = Fmax / tot; Fx *= k; Fy *= k;
        // A spinning driven tyre still holds some of its cornering force (spinLat), so power slides build gradually.
        const keep = this.spec.spinLat * Math.min(1, Fmax / Math.max(Math.abs(Fy / k), 1));
        if (Fdrive > 0 && k < keep) { Fy *= keep / k; Fx = Math.sign(Fx) * gx * Math.sqrt(Math.max(0, Fmax * Fmax - Fy * Fy)); }
        // ...and still drives the car forward (spinDrive share of its traction, whatever it is doing sideways), so
        // a slide on the power keeps its speed instead of bogging down.
        if (Fdrive > 0 && FxAsked > 0) Fx = Math.max(Fx, Math.min(FxAsked, this.spec.spinDrive * gx * Fmax));
      }
      // no overshoot at low speed: never reverse the corner's lateral velocity in one step
      const maxFy = (mc * Math.abs(vy)) / dt;
      Fy = clamp(Fy, -maxFy, maxFy);
      // Steering flex: the cornering force bends the rack and bushes, turning the wheel back towards straight. The
      // car needs more lock the harder it corners (understeer), and the limit stays where it was.
      if (w.front && this.spec.steerComply > 0) w.comply += (-this.spec.steerComply * Fy - w.comply) * Math.min(1, dt / COMPLY_T);

      const ax = (wf.x * Fx + ws.x * Fy) * dt, ay = (wf.y * Fx + ws.y * Fy) * dt, az = (wf.z * Fx + ws.z * Fy) * dt;
      const lift = this.spec.forceHeight;
      b.applyImpulseAtPoint({ x: ax, y: ay, z: az }, { x: w.contact.x + up.x * lift, y: w.contact.y + up.y * lift, z: w.contact.z + up.z * lift }, true);

      w.slip = Math.max(Math.abs(alpha) / (bt ? 0.87 * bt.peak : 0.15), slide * 2);   // about 1.15 at the peak slip angle
      w.omega = vx / this.spec.wheelRadius * (1 + (!w.front && Fdrive > 0 ? slide * 0.8 : 0)) * (brake > 0.9 && slide > 0.3 ? 0.2 : 1);
    }
    // CoM share of the ploughing resistance, along -velocity in the ground plane; never reverses the car in one tick
    const vh = Math.hypot(this.vel.x, this.vel.z);
    if (plough > 0 && vh > 0.05) {
      const imp = Math.min(plough * dt, this.spec.mass * vh * 0.5);
      b.applyImpulse({ x: (-this.vel.x / vh) * imp, y: 0, z: (-this.vel.z / vh) * imp }, true);
    }

    // --- yaw limit: past yawCap's margin over the rate the tyres could corner at (latAccel / speed), the excess
    // spin is bled off, so the tail can't whip round faster than the driver can follow.
    const [capMargin, capLat, capGain] = this.spec.yawCap;
    if (capGain > 0) {
      const yaw = this.angv.dot(up), over = Math.abs(yaw) - (capMargin + capLat / Math.max(v, 5));
      if (over > 0) {
        const j = -Math.sign(yaw) * Math.min(over, over * capGain * dt) * this.spec.inertia.y;
        b.applyTorqueImpulse({ x: up.x * j, y: up.y * j, z: up.z * j }, true);
      }
    }

    // --- aero
    const vf = Math.max(0, vF);
    const DF = 0.5 * this.spec.rho * this.spec.ClA * vf * vf;
    const frontPt = _v1.copy(this.pos).addScaledVector(this.fwd, this.spec.zFront);
    const dfF = DF * this.spec.aeroFront * dt, dfR = DF * (1 - this.spec.aeroFront) * dt;
    b.applyImpulseAtPoint({ x: -up.x * dfF, y: -up.y * dfF, z: -up.z * dfF }, frontPt, true);
    const rearPt = _v1.copy(this.pos).addScaledVector(this.fwd, this.spec.zRear);
    b.applyImpulseAtPoint({ x: -up.x * dfR, y: -up.y * dfR, z: -up.z * dfR }, rearPt, true);
    if (v > 0.1) {
      const drag = 0.5 * this.spec.rho * this.spec.CdA * v * v * dt;
      b.applyImpulse({ x: (-this.vel.x / v) * drag, y: (-this.vel.y / v) * drag, z: (-this.vel.z / v) * drag }, true);
    }
  }

  // Interpolated visual update
  render(alpha: number, dt: number) {
    const m = this.mesh;
    m.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    m.root.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
    this.wheels.forEach((w, k) => {
      const wm = m.wheels[k];
      wm.pivot.position.set(w.local.x, w.local.y - w.L, w.local.z);
      wm.pivot.rotation.y = w.front ? this.steer : 0;
      w.spin += w.omega * dt;
      wm.spinner.rotation.x = w.spin;
    });
    poseCockpit(m.cockpit, this.steer);
    m.brakeLight.material.emissiveIntensity = this.brake > 0.1 ? 3 : 0.4;
  }
}
