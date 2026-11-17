import { resolveCarToCarObbCollision, type RigidBodyCollisionCar } from './lc/vendor/sim/track-evolution';
import type { Vehicle } from './vehicle';

// ============================================================================
// Car-to-car contact, engine-neutral. Each car is a box in the ground plane (ContactBody): the session's own cars on
// either engine (contactBody reads a Vehicle) or, later, another player's car known only from the network. The solver
// is LibreCorsa's (resolveCarToCarObbCollision: separating axes, then one normal and friction impulse at the contact
// point with the yaw lever arms), which returns the change to each side; a pair can apply both sides (two cars in
// this session) or only one (this session's car against a body another client simulates, which applies its own).
// World axes as everywhere: y up, yaw rate = angular velocity about +y (positive turns a car facing +z towards +x,
// its left).
// ============================================================================

// A car's collision footprint about its centre of mass (Vehicle.shape), and its mass for the impulse.
export interface ContactShape {
  readonly front: number;            // m from the centre of mass to the nose
  readonly rear: number;             // m from the centre of mass to the tail
  readonly halfWidth: number;        // m
  readonly mass: number;             // kg
  readonly yawInertia: number;       // kg m^2 about the vertical axis through the centre of mass
}

// One car as the solver sees it, in world coordinates. A plain object, so a network layer can fill it from a snapshot.
export interface ContactBody {
  x: number; y: number; z: number;   // centre of mass (m)
  fwdX: number; fwdZ: number;        // unit heading in the ground plane
  vx: number; vz: number;            // velocity of the centre of mass in the ground plane (m/s)
  yawRate: number;                   // rad/s about +y
  shape: ContactShape;
}

// The change one contact makes to one car: move its centre of mass by (dx, dz), add (dvx, dvz) to its velocity and
// dyaw to its yaw rate. Vehicle.applyContact takes it.
export interface ContactDelta { dx: number; dz: number; dvx: number; dvz: number; dyaw: number }

export interface Contact {
  readonly speed: number;            // closing speed along the normal at the contact point (m/s); 0 if already parting
  readonly depth: number;            // overlap along the normal (m)
  readonly x: number; readonly z: number;   // contact point
  readonly nx: number; readonly nz: number; // unit normal from a to b
  readonly a: ContactDelta;
  readonly b: ContactDelta;
}

export const RESTITUTION = 0.22, FRICTION = 0.28;   // the solver's own defaults: a dull, scraping hit
// Most a contact moves each car per tick to undo the overlap (m). The solver allows 0.25, which at 120 Hz is a 30 m/s
// sideways jump: two cars placed on top of each other burst apart in four ticks. At 0.05 (6 m/s) they slide apart
// over about 0.2 s; in a real hit the impulse parts them anyway, and the overlap of a tick's travel at 120 Hz is small.
export const MAX_PUSH = 0.05;

export function newBody(shape: ContactShape): ContactBody {
  return { x: 0, y: 0, z: 0, fwdX: 0, fwdZ: 1, vx: 0, vz: 0, yawRate: 0, shape };
}

// A Vehicle's current state (after readState) as a ContactBody, written into `out`.
export function contactBody(car: Vehicle, out: ContactBody = newBody(car.shape)): ContactBody {
  const f = car.fwd, len = Math.hypot(f.x, f.z);
  out.x = car.pos.x; out.y = car.pos.y; out.z = car.pos.z;
  // a car on its side or nose has no heading in the plane: keep the last one
  if (len > 1e-3) { out.fwdX = f.x / len; out.fwdZ = f.z / len; }
  out.vx = car.vel.x; out.vz = car.vel.z;
  out.yawRate = car.angv.y;
  out.shape = car.shape;
  return out;
}

// The solver's view of a body: its box is centred between nose and tail, which on the F1 is 0.55 m ahead of the
// centre of mass, and it takes that centre for the box's position and the point it rotates about. So it is handed the
// box centre and that point's velocity (the same rigid motion), and the yaw change is worked out again below about
// the real centre of mass.
const sa: RigidBodyCollisionCar = { x: 0, y: 0, z: 0, fwdX: 0, fwdZ: 1, vx: 0, vz: 0, yawRateRadS: 0, massKg: 0, yawInertiaKgM2: 0, halfLengthM: 0, halfWidthM: 0 };
const sb: RigidBodyCollisionCar = { ...sa };
function solverBody(b: ContactBody, out: RigidBodyCollisionCar) {
  const s = b.shape, off = 0.5 * (s.front - s.rear), ox = b.fwdX * off, oz = b.fwdZ * off;
  out.x = b.x + ox; out.y = b.y; out.z = b.z + oz;
  out.fwdX = b.fwdX; out.fwdZ = b.fwdZ;
  out.vx = b.vx + b.yawRate * oz; out.vz = b.vz - b.yawRate * ox;   // v + w x r, w = (0, yawRate, 0)
  out.yawRateRadS = b.yawRate;
  out.massKg = s.mass; out.yawInertiaKgM2 = s.yawInertia;
  out.halfLengthM = 0.5 * (s.front + s.rear); out.halfWidthM = s.halfWidth;
  return out;
}

// The contact between a and b, or null when the boxes do not overlap (or are more than 1.4 m apart in height).
// Both sides' changes are always worked out; the caller applies one or both.
export function collide(a: ContactBody, b: ContactBody): Contact | null {
  const r = resolveCarToCarObbCollision(solverBody(a, sa), solverBody(b, sb), RESTITUTION, FRICTION);
  if (!r.collided) return null;
  // The impulse on b is J = m_b dv_b (on a, -J). Its yaw change about each centre of mass: (r x J)_y / I.
  const ma = Math.max(100, a.shape.mass), mb = Math.max(100, b.shape.mass);
  const jx = r.velDeltaB[0] * mb, jz = r.velDeltaB[1] * mb;
  const yaw = (body: ContactBody, sign: number) => {
    const rx = r.contactX - body.x, rz = r.contactZ - body.z;
    return sign * (rz * jx - rx * jz) / Math.max(100, body.shape.yawInertia);
  };
  const sep = Math.hypot(r.posDeltaA[0], r.posDeltaA[1]), k = sep > MAX_PUSH ? MAX_PUSH / sep : 1;
  return {
    speed: r.impactSpeedMs, depth: r.penetrationM, x: r.contactX, z: r.contactZ, nx: r.nx, nz: r.nz,
    a: { dx: k * r.posDeltaA[0], dz: k * r.posDeltaA[1], dvx: -jx / ma, dvz: -jz / ma, dyaw: yaw(a, -1) },
    b: { dx: k * r.posDeltaB[0], dz: k * r.posDeltaB[1], dvx: r.velDeltaB[0], dvz: r.velDeltaB[1], dyaw: yaw(b, 1) },
  };
}
