import * as THREE from 'three';
import { Car } from '../car';
import { G_WALL } from '../config';
import { LcCar } from '../lc/lcCar';
import type { VehicleInputs } from '../lc/vendor/sim/f12026-car/VehiclePhysics';
import type { Vehicle } from '../vehicle';

// ============================================================================
// Barrier contact per physics tick, for the RL environment's reward and observation, read from whichever engine
// drives the car and never acted on: whether the car touched a wall during the tick, and the hardest hit's speed
// into it (m/s: the contact point's velocity along the wall's normal before the wall pushed back; about 0 for a
// scrape along it). Kept here rather than in the cars, so the game's bundle carries none of it.
//   Rapier (our physics): the world's contact pairs between the car's colliders and the walls after the step, with
//     the velocity the car had as the tick began.
//   LibreCorsa: the engine's own per-step telemetry (wallContact, wallImpactMs), over every engine step in the tick,
//     by wrapping its step method (the engine instance is replaced on a spawn: attach after every placement). An
//     engine is wrapped once and reports to the sensor attached to it last (a policy driver made again in the game
//     picks up the same engine).
// ============================================================================
const _v = new THREE.Vector3(), _r = new THREE.Vector3();
const owner = new WeakMap<object, WallSensor>();

export class WallSensor {
  contact = false; hit = 0;
  private readonly preVel = new THREE.Vector3(); private readonly preAngv = new THREE.Vector3();
  private lcContact = false; private lcHit = 0;

  // After a placement: hook a LibreCorsa engine's steps.
  attach(car: Vehicle) {
    this.contact = false; this.hit = 0;
    if (!(car instanceof LcCar)) return;
    const v = car.vehicle, hooked = owner.has(v);
    owner.set(v, this);
    if (hooked) return;
    const step = v.step.bind(v);
    v.step = (dt: number, inputs: VehicleInputs) => {
      step(dt, inputs);
      const t = v.telemetry, s = owner.get(v)!;
      if (t.wallContact) s.lcContact = true;
      if (t.wallImpactMs > s.lcHit) s.lcHit = t.wallImpactMs;
    };
  }

  beforeTick(car: Vehicle) {
    this.lcContact = false; this.lcHit = 0;
    this.preVel.copy(car.vel); this.preAngv.copy(car.angv);
  }

  afterTick(car: Vehicle) {
    if (car instanceof Car) this.readRapier(car);
    else { this.contact = this.lcContact; this.hit = this.lcHit; }
  }

  private readRapier(car: Car) {
    let touch = false, hit = 0;
    const b = car.body, w = car.world, pos = car.pos;
    for (let k = 0, n = b.numColliders(); k < n; k++) {
      const c = b.collider(k);
      w.contactPairsWith(c, (o) => {
        if (!((o.collisionGroups() >>> 16) & G_WALL)) return;
        w.contactPair(c, o, (m) => {
          let pushed = false;
          for (let i = 0, nc = m.numContacts(); i < nc; i++) if (m.contactImpulse(i) > 0) pushed = true;
          if (!pushed) return;
          touch = true;
          // the normal into the wall: the wall cuboid's centre lies behind its face
          const nm = m.normal(), wc = o.translation();
          const sgn = (wc.x - pos.x) * nm.x + (wc.z - pos.z) * nm.z < 0 ? -1 : 1;
          const ns = m.numSolverContacts();
          for (let i = 0; i < Math.max(1, ns); i++) {
            const p = ns > 0 ? m.solverContactPoint(i) : pos;
            _v.copy(this.preAngv).cross(_r.set(p.x - pos.x, p.y - pos.y, p.z - pos.z)).add(this.preVel);
            hit = Math.max(hit, sgn * (_v.x * nm.x + _v.y * nm.y + _v.z * nm.z));
          }
        });
      });
    }
    this.contact = touch; this.hit = hit;
  }
}
