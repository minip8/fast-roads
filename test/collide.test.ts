// Car-to-car contact (src/collide.ts) and the Session's extra cars: the solver's deltas on their own, then real cars on
// both engines meeting on Melbourne's start straight.
import { describe, expect, test } from 'vitest';
import { CARS, type CarId } from '../src/cars';
import { collide, MAX_PUSH, newBody, type ContactBody, type ContactShape } from '../src/collide';
import { DT } from '../src/config';
import type { CarContact } from '../src/sim';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { session } from './harness';

const coast = (): DriveInput => ({ throttle: 0, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true });
const GT3: ContactShape = { front: 2.3, rear: 2.4, halfWidth: 1.03, mass: 1460, yawInertia: 2600 };
const F1: ContactShape = { front: 3.2, rear: 2.1, halfWidth: 0.93, mass: 803, yawInertia: 1100 };
const body = (shape: ContactShape, b: Partial<ContactBody>): ContactBody => Object.assign(newBody(shape), b);
const cross = (rx: number, rz: number, jx: number, jz: number) => rz * jx - rx * jz;   // (r x J)_y

describe('collide (the solver alone)', () => {
  test('a glancing hit: equal and opposite impulses, angular momentum kept, overlap undone at most MAX_PUSH a side', () => {
    // b ahead of a and to its left, turned 0.3 rad, a closing at 10 m/s and turning
    const a = body(GT3, { x: 0, z: 0, vz: 20, yawRate: 0.2 });
    const b = body(F1, { x: 1.2, z: 4.2, fwdX: Math.sin(0.3), fwdZ: Math.cos(0.3), vx: 1, vz: 10 });
    const c = collide(a, b)!;
    expect(c).not.toBeNull();
    expect(c.speed).toBeGreaterThan(5);
    const ja = [c.a.dvx * a.shape.mass, c.a.dvz * a.shape.mass], jb = [c.b.dvx * b.shape.mass, c.b.dvz * b.shape.mass];
    expect(ja[0] + jb[0]).toBeCloseTo(0, 6); expect(ja[1] + jb[1]).toBeCloseTo(0, 6);
    expect(c.b.dvz).toBeGreaterThan(0);                 // the car hit from behind is pushed on
    expect(c.a.dx).toBeCloseTo(-c.b.dx, 9); expect(c.a.dz).toBeCloseTo(-c.b.dz, 9);
    expect(Math.hypot(c.a.dx, c.a.dz)).toBeLessThanOrEqual(MAX_PUSH + 1e-9);
    // angular momentum about the contact point: I dw + (cg - p) x m dv sums to 0 over both cars
    const L = (bd: ContactBody, d: typeof c.a) => bd.shape.yawInertia * d.dyaw + cross(bd.x - c.x, bd.z - c.z, d.dvx * bd.shape.mass, d.dvz * bd.shape.mass);
    expect(L(a, c.a) + L(b, c.b)).toBeCloseTo(0, 6);
    // the contact is at the front of a (its box runs 2.3 m ahead of its centre of mass), not beyond it
    expect(c.z).toBeGreaterThan(1.8); expect(c.z).toBeLessThan(2.4);
  });

  test('the box is the outline about the centre of mass: the F1 reaches 3.2 m forward but only 2.1 m back', () => {
    const f1 = body(F1, {}), other = (z: number) => body(GT3, { z });
    expect(collide(f1, other(3.2 + 2.4 - 0.05))).not.toBeNull();   // the other car's tail just over the F1's nose
    expect(collide(f1, other(3.2 + 2.4 + 0.05))).toBeNull();
    expect(collide(f1, other(-(2.1 + 2.3) + 0.05))).not.toBeNull();   // ...its nose just under the F1's tail
    expect(collide(f1, other(-(2.1 + 2.3) - 0.05))).toBeNull();
  });

  test('yaw sign: a push to the left at the tail turns the nose right (yaw rate down); at the nose, left (up)', () => {
    const car = () => body(GT3, {});
    const tail = collide(car(), body(GT3, { x: -2.0, z: -3.5, vx: 3 }))!;   // b on the right (x is left), behind, moving left
    expect(tail.a.dvx).toBeGreaterThan(0);                // pushed left
    expect(tail.a.dyaw).toBeLessThan(0);
    const nose = collide(car(), body(GT3, { x: -2.0, z: 3.5, vx: 3 }))!;
    expect(nose.a.dvx).toBeGreaterThan(0);
    expect(nose.a.dyaw).toBeGreaterThan(0);
  });
});

// A session on Melbourne's start straight with the player's car and one more, both placed by the test.
async function pair(playerId: CarId, otherId: CarId) {
  const t = await session(playerId);
  const { car, track } = t, s0 = track.L - 160;
  const other = t.session.addCar(CARS[otherId], { s: s0, speed: 0, driver: coast });
  const contacts: CarContact[] = [];
  const run = (secs: number, driver: (c: Vehicle) => DriveInput = coast, every?: () => void) => {
    for (let k = 0, n = Math.round(secs / DT); k < n; k++) {
      t.session.tick(driver(car), false);
      contacts.push(...t.session.contacts);
      every?.();
    }
  };
  return { ...t, s0, other, contacts, run };
}
const place = (car: Vehicle, s: number, lat: number, kmh: number, heading = 0) => car.placeAt(s, lat, kmh / 3.6, heading);
const yawRate = (c: Vehicle) => Math.abs(c.angv.y);
// how far apart the two cars are along the track, and across it
const along = (a: Vehicle, b: Vehicle) => b.proj.s - a.proj.s, across = (a: Vehicle, b: Vehicle) => b.proj.lat - a.proj.lat;

describe('cars in a session', () => {
  test('rear-end, GT3 into GT3: the one behind slows, the one ahead is pushed on, nobody spins', async () => {
    const { car, other, s0, run, contacts } = await pair('lcgt3', 'lcgt3');
    place(car, s0, 0, 150); place(other.car, s0 + 12, 0, 80);
    let worstYaw = 0;
    run(1.5, coast, () => { worstYaw = Math.max(worstYaw, yawRate(car), yawRate(other.car)); });
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0].contact.speed).toBeGreaterThan(15);   // about 70 km/h closing
    expect(contacts[0].contact.speed).toBeLessThan(22);
    expect(along(car, other.car)).toBeGreaterThan(4.6);      // still behind it, not through it
    expect(other.car.speedF).toBeGreaterThanOrEqual(car.speedF - 0.5);   // no longer closing
    expect(other.car.speedF * 3.6).toBeGreaterThan(95);      // momentum went forward
    expect(car.speedF * 3.6).toBeLessThan(125);
    expect(worstYaw).toBeLessThan(0.3);
    expect(Math.abs(across(car, other.car))).toBeLessThan(0.5);
    for (const c of [car, other.car]) expect(c.up.y).toBeGreaterThan(0.98);
  });

  test('side by side: steering into the other car pushes it across without launching or spinning either', async () => {
    const { car, other, s0, run, contacts } = await pair('lcgt3', 'lcgt3');
    place(car, s0, -1.4, 120); place(other.car, s0 + 1, 1.4, 120);
    // the player leans on the other car (steering a little towards it) for a second; the other steers straight
    const toward = (c: Vehicle) => Math.sign((other.car.pos.x - c.pos.x) * c.left.x + (other.car.pos.z - c.pos.z) * c.left.z);
    let worstYaw = 0, worstVy = 0;
    run(1.2, (c) => ({ ...coast(), throttle: 0.3, steerAngle: 0.02 * toward(c) }), () => {
      worstYaw = Math.max(worstYaw, yawRate(car), yawRate(other.car));
      worstVy = Math.max(worstVy, Math.abs(car.vel.y), Math.abs(other.car.vel.y));
    });
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0].contact.speed).toBeLessThan(4);        // a lean, not a hit
    expect(Math.abs(across(car, other.car))).toBeGreaterThan(2 * 1.03 - 0.1);   // apart, not overlapping
    expect(Math.abs(other.car.proj.lat)).toBeGreaterThan(1.8);   // pushed across
    expect(worstYaw).toBeLessThan(0.3);
    expect(worstVy).toBeLessThan(0.3);                        // no launch
    for (const c of [car, other.car]) expect(c.speedF * 3.6).toBeGreaterThan(112);
  });

  // 300 km/h into a car at rest: 83 m/s closing, 0.7 m a tick, then head-on at the same closing speed
  for (const [what, kmh, heading] of [['rear-end', 0, 0], ['head-on', 150, Math.PI]] as const) {
    test(`no tunnelling: F1 at ${300 - kmh} km/h ${what} into a GT3 at ${kmh}`, async () => {
      const { car, other, s0, run, contacts } = await pair('lcf1', 'lcgt3');
      place(car, s0, 0, 300 - kmh); place(other.car, s0 + 20, 0, kmh, heading);
      run(0.6);
      expect(contacts.length).toBeGreaterThan(0);
      expect(contacts[0].contact.speed).toBeGreaterThan(80);
      expect(Math.max(...contacts.map((c) => c.contact.depth))).toBeLessThan(0.8);   // never more than a tick's travel
      expect(along(car, other.car)).toBeGreaterThan(4);    // still nose to tail (or nose to nose)
      expect(car.speedF).toBeLessThan(other.car.speedF * Math.cos(heading) + 0.5);   // parted, not passing through
      for (const c of [car, other.car]) expect(c.up.y).toBeGreaterThan(0.9);
    });
  }

  test('placed on top of each other (as after a restart), the cars slide apart gently', async () => {
    const { car, other, s0, run, contacts } = await pair('lcgt3', 'lcgt3');
    place(car, s0, 0, 100); place(other.car, s0, 0, 100);
    let worstYaw = 0, worstLat = 0, last = 0;
    run(1, coast, () => {
      worstYaw = Math.max(worstYaw, yawRate(car), yawRate(other.car));
      worstLat = Math.max(worstLat, Math.abs(car.vel.dot(car.left)), Math.abs(other.car.vel.dot(other.car.left)));
      if (contacts.length) last = contacts.length;
    });
    const ticks = new Set(contacts.map((c) => c.contact)).size;
    expect(ticks).toBeGreaterThan(10);                       // MAX_PUSH a tick: no burst apart
    expect(ticks).toBeLessThan(40);                          // ...but apart within a third of a second
    expect(last).toBe(contacts.length);
    expect(Math.abs(across(car, other.car))).toBeGreaterThan(2 * 1.03 - 0.05);
    expect(worstYaw).toBeLessThan(0.2);
    expect(worstLat).toBeLessThan(1.5);
    for (const c of [car, other.car]) { expect(c.up.y).toBeGreaterThan(0.98); expect(c.speedF * 3.6).toBeGreaterThan(90); }
  });

  test('both sides applied: the impulses are equal and opposite (drift car into a GT3)', async () => {
    const { car, other, s0, run, contacts } = await pair('drift', 'lcgt3');
    place(car, s0, 0.3, 140); place(other.car, s0 + 10, 0, 90);
    run(1);
    expect(contacts.length).toBeGreaterThan(0);
    for (const { a, b, contact: c } of contacts) {
      const mb = (b as Vehicle).shape.mass;
      expect(c.a.dvx * a.shape.mass + c.b.dvx * mb).toBeCloseTo(0, 6);
      expect(c.a.dvz * a.shape.mass + c.b.dvz * mb).toBeCloseTo(0, 6);
    }
    expect(contacts[0].a).toBe(car);
    expect(other.car.speedF * 3.6).toBeGreaterThan(100);
    expect(car.speedF * 3.6).toBeLessThan(125);
    for (const c of [car, other.car]) { expect(c.up.y).toBeGreaterThan(0.98); expect(yawRate(c)).toBeLessThan(0.5); }
  });

  for (const id of ['lcgt3', 'drift'] as const) {
    test(`applyContact on ${id}: the body moves by the deltas and the engine carries them on`, async () => {
      const { car, run } = await session(id).then((t) => ({ ...t, run: (secs: number) => t.drive(secs, coast) }));
      run(0.5);                                              // settled at rest
      const p = car.pos.clone(), v = car.vel.clone(), w = car.angv.y;
      car.applyContact({ dx: 0.05, dz: -0.03, dvx: 1, dvz: -0.5, dyaw: 0.4 });
      expect(car.pos.x - p.x).toBeCloseTo(0.05, 5); expect(car.pos.z - p.z).toBeCloseTo(-0.03, 5);   // Rapier keeps 32-bit floats
      expect(car.vel.x - v.x).toBeCloseTo(1, 5); expect(car.vel.z - v.z).toBeCloseTo(-0.5, 5);
      expect(car.angv.y - w).toBeCloseTo(0.4, 5);
      const yaw0 = Math.atan2(car.fwd.x, car.fwd.z);
      run(DT);                                               // one tick: the engine started from the new state
      expect(car.angv.y).toBeGreaterThan(0.2);
      expect(Math.atan2(car.fwd.x, car.fwd.z)).toBeGreaterThan(yaw0);   // + yaw rate turns the nose towards +x (left)
      expect(car.vel.x).toBeGreaterThan(0.5);
    });

    test(`a proxy body (one side only) shoves ${id}'s tail left: the nose turns right, the proxy is left alone`, async () => {
      const t = await session(id), { car } = t;
      t.drive(0.5, coast);
      const L = car.left, F = car.fwd, gap = car.shape.halfWidth + GT3.halfWidth - 0.05;
      const proxy = body(GT3, {
        x: car.pos.x - L.x * gap - F.x * 1.6, y: car.pos.y, z: car.pos.z - L.z * gap - F.z * 1.6,
        fwdX: F.x, fwdZ: F.z, vx: L.x * 6, vz: L.z * 6,       // on the car's right, behind its middle, moving left
      });
      const before = JSON.stringify(proxy), yaw0 = Math.atan2(F.x, F.z);
      t.session.proxies.push(proxy);
      t.drive(DT, coast);
      const hit = t.session.contacts;
      t.session.proxies.length = 0;                          // one hit
      expect(hit.length).toBe(1);
      expect(hit[0].a).toBe(car); expect(hit[0].b).toBe(proxy);
      expect(JSON.stringify(proxy)).toBe(before);
      expect(car.angv.y).toBeLessThan(-0.1);
      expect(car.vel.dot(car.left)).toBeGreaterThan(0.5);
      t.drive(0.3, coast);
      expect(Math.atan2(car.fwd.x, car.fwd.z)).toBeLessThan(yaw0 - 0.01);
      expect(t.session.contacts.length).toBe(0);
    });
  }

  test('extra cars: autopilot opponents lap with the player, are put back on restart, and can be removed', async () => {
    const t = await session('lcgt3', { flying: true }), { car, session: s } = t;
    const children = (car.mesh.root.parent?.children.length ?? 0);
    const o = s.addCar(CARS.lcf1, { s: s.track.L - 300 });   // 260 m ahead of the GT3's start spot, at the F1's flying speed
    expect(car.mesh.root.parent?.children.length).toBe(children + 1);
    t.drive(3);
    expect(o.car.proj.s).toBeGreaterThan(s.track.L - 300 + 100);
    expect(s.contacts.length).toBe(0);
    s.restart();
    expect(Math.abs(o.car.proj.s - (s.track.L - 300))).toBeLessThan(1);
    s.removeCar(o);
    expect(s.others.length).toBe(0);
    expect(car.mesh.root.parent?.children.length).toBe(children);
  });
});
