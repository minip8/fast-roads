// Cars on LibreCorsa's engine (LcCar, src/lc/lcCar.ts) in the game's own session: placed, driven, reset, shifted,
// crashed and rendered as the game does, through each car's driver (src/lc/driver.ts: pedal ramps, steering, ABS and
// traction control). The driver itself is tested on flat ground in lc-driver.ts.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DT, KERB_W, S_ASPHALT, S_GRASS, S_GRAVEL } from '../src/config';
import { LcCar } from '../src/lc/lcCar';
import { VehiclePhysics } from '../src/lc/vendor/sim/f12026-car/VehiclePhysics';
import { needsReset } from '../src/sim';
import { pointAt } from '../src/track';
import { TRACKS } from '../src/tracks';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { session } from './harness';

export const lc = (car: Vehicle) => { if (!(car instanceof LcCar)) throw new Error(`${car.spec.id} is not on LibreCorsa's engine`); return car; };
export const inp = (o: Partial<DriveInput> = {}): DriveInput => ({ throttle: 0, brake: 0, steer: 0, analog: true, steerAngle: 0, ...o });
// Throttle that holds about `v` m/s (a gentle pedal: the stand-in driver has no traction control)
export const cruise = (car: Vehicle, v: number, max = 0.4) => Math.min(max, Math.max(0, 0.1 + 0.15 * (v - car.speedF)));
const finite = (car: Vehicle) => [...car.pos.toArray(), ...car.quat.toArray(), ...car.vel.toArray(), ...car.angv.toArray(), car.rpm, car.steer]
  .every(Number.isFinite) && lc(car).vehicle.stateIsSane();

// What every car on the engine must do, as the game uses it. Each car runs it from its own file, in parallel.
export function lcCarSuite(id: 'lcgt3' | 'lcf1') {
  describe(id, () => {
    it.each(['melbourne', 'silverstone'] as const)('starts on the grid at %s: at rest, settled, on its wheels on the asphalt', async (track) => {
      const { car, track: tr, drive } = await session(id, { track });
      const grid = pointAt(tr, tr.L - TRACKS[track].startBack, 0);
      expect(Math.hypot(car.pos.x - grid.x, car.pos.z - grid.z)).toBeLessThan(0.05);
      expect(car.fwd.x * tr.TX[grid.i] + car.fwd.z * tr.TZ[grid.i]).toBeGreaterThan(0.9999);
      expect(car.up.y).toBeGreaterThan(0.999);
      expect(car.vel.length()).toBeLessThan(0.05);
      expect(Math.abs(car.pos.y - car.spec.comHeight)).toBeLessThan(0.03);
      expect(car.prevPos.equals(car.pos) && car.prevQuat.equals(car.quat)).toBe(true);
      expect(car.wheels.every((w) => w.grounded && w.surf === S_ASPHALT && !w.out)).toBe(true);
      expect([car.gear, car.tipped, car.speedF]).toEqual([1, 0, expect.closeTo(0, 1)]);
      const v = lc(car).vehicle, mg = v.totalMassKg * 9.81;
      expect(v.wheels.reduce((a, w) => a + w.fz, 0) / mg).toBeCloseTo(1, 1);
      // settled: left alone it stays put
      const at = car.pos.clone();
      drive(1, () => inp());
      expect(car.pos.distanceTo(at)).toBeLessThan(0.02);
    });

    // At walking pace the path's curvature is the steering geometry's, tan(angle) / wheelbase: positive angles turn left.
    it.each([1, -1])('follows the radius its wheel angle asks for (side %i)', async (side) => {
      const { car, drive } = await session(id, { walls: false });
      car.forceSurface = S_ASPHALT;
      const wb = car.spec.zFront - car.spec.zRear, angle = side * Math.atan(wb / 30);
      const curv: number[] = [];
      drive(10, (c, t) => {
        if (t > 6) curv.push(c.angv.dot(c.up) / c.speedF);
        return inp({ throttle: cruise(c, 7), steerAngle: angle });
      });
      const mean = curv.reduce((a, b) => a + b, 0) / curv.length;
      expect(car.speedF).toBeGreaterThan(6);
      expect(mean * 30 * side).toBeGreaterThan(0.9);
      expect(mean * 30 * side).toBeLessThan(1.02);
      expect(car.steer * side).toBeGreaterThan(Math.abs(angle) * 0.95);   // the reported angle is the road wheels'
      expect(car.steer * side).toBeLessThan(Math.abs(angle) * 1.1);
    });

    it('honours forceSurface, and grass and gravel slow it', async () => {
      // Coasting from 72 km/h for 2 s with every wheel on the surface
      const lossOn = async (surf: number) => {
        const { car, drive } = await session(id, { walls: false });
        car.forceSurface = S_ASPHALT;
        drive(10, (c) => inp({ throttle: cruise(c, 20) }), () => car.speedF > 20);
        const v0 = car.speedF;
        car.forceSurface = surf;
        drive(2, () => inp());
        expect(car.wheels.every((w) => w.surf === surf)).toBe(true);
        expect(lc(car).vehicle.telemetry.surface).toEqual(Array(4).fill(['road', 'kerb', 'grass', 'gravel'][surf]));
        return v0 - car.speedF;
      };
      const asphalt = await lossOn(S_ASPHALT), grass = await lossOn(S_GRASS), gravel = await lossOn(S_GRAVEL);
      expect(grass).toBeGreaterThan(asphalt + 0.4);     // 4 % of the load as plough drag: ~0.4 m/s2
      expect(gravel).toBeGreaterThan(asphalt + 5);      // 0.5 g of it in the gravel

      // Put on the grass, it is on the grass, unless told otherwise
      const { car, track, drive } = await session(id, { walls: false });
      const off = track.WL[track.N - 80] + KERB_W + 4;
      car.placeAt(track.S[track.N - 80], off);
      expect(car.wheels.every((w) => w.surf === S_GRASS && w.out)).toBe(true);
      expect(lc(car).vehicle.telemetry.surface).toEqual(Array(4).fill('grass'));
      car.forceSurface = S_ASPHALT;
      drive(0.1, () => inp());
      expect(car.wheels.every((w) => w.surf === S_ASPHALT && w.out)).toBe(true);
      expect(lc(car).vehicle.telemetry.surface).toEqual(Array(4).fill('road'));
    });

    it('is stopped by the barrier', async () => {
      const { car, track, drive } = await session(id);
      drive(3, (c) => inp({ throttle: cruise(c, 15) }), () => car.speedF > 14);
      let contact = false, maxLat = -Infinity, ok = true;
      drive(4, () => inp({ throttle: 0.25, steerAngle: 0.25 }), () => {
        contact ||= lc(car).vehicle.telemetry.wallContact;
        maxLat = Math.max(maxLat, car.proj.lat - track.barL[car.proj.i]);
        ok &&= finite(car);
        return false;
      });
      expect(contact).toBe(true);
      expect(maxLat).toBeLessThan(-1);       // the centre of mass stays on the road side of the barrier
      expect(Math.abs(car.speedF)).toBeLessThan(0.5);
      expect(ok).toBe(true);
    });

    it('is put back on the track (same car, fresh tyres) and restarted (a fresh car at the start)', async () => {
      const { car, track, drive, session: s } = await session(id, { walls: false });
      const first = lc(car).vehicle, blanket = first.wheels.map((w) => w.surfaceTempC);
      drive(6, (c, t) => inp({ throttle: cruise(c, 30, 0.6), steerAngle: 0.02 * Math.sin(t) }));
      const v = lc(car).vehicle, battery = v.ersEnergyJ, deployed = v.lapDeployJ, at = car.proj.s;
      expect(v.wheels.some((w) => w.surfaceTempC !== v.wheels[0].surfaceTempC || w.surfaceTempC > 70)).toBe(true);
      car.placeAt(at);
      expect(lc(car).vehicle).toBe(first);
      expect(Math.abs(car.proj.s - at)).toBeLessThan(0.5);
      expect(Math.abs(car.proj.lat)).toBeLessThan(0.05);
      expect([car.gear, car.tipped, car.prevPos.equals(car.pos)]).toEqual([1, 0, true]);
      expect(car.vel.length()).toBeLessThan(0.05);
      expect([v.ersEnergyJ, v.lapDeployJ]).toEqual([battery, deployed]);   // the battery and lap energy are kept
      expect(v.wheels.map((w) => w.surfaceTempC)).toEqual(blanket);        // ...on tyres back in their blankets
      s.restart();
      const fresh = lc(car).vehicle;
      expect(fresh).not.toBe(first);
      expect(fresh.ersEnergyJ).toBe(fresh.config.ers.ERS_MAX_CHARGE);
      expect(fresh.fuelMassKg).toBe(lc(car).spec.fuelKg);
      const grid = pointAt(track, track.L - TRACKS.melbourne.startBack, 0);
      expect(Math.hypot(car.pos.x - grid.x, car.pos.z - grid.z)).toBeLessThan(0.05);
      expect(car.vel.length()).toBeLessThan(0.05);
      // An engine state gone non-finite in the middle of a tick is put back at the start within that tick (a fresh
      // car again): nothing that reads the car afterwards (timing, camera) ever sees it
      drive(2, (c) => inp({ throttle: cruise(c, 15) }));
      expect(Math.hypot(car.pos.x - grid.x, car.pos.z - grid.z)).toBeGreaterThan(3);
      const step = fresh.step.bind(fresh);
      let calls = 0;
      fresh.step = (h, i) => { step(h, i); if (++calls === 3) fresh.velocity.x = Number.NaN; };
      drive(DT, () => inp());
      expect(finite(car)).toBe(true);
      expect(lc(car).vehicle).not.toBe(fresh);
      expect(Math.hypot(car.pos.x - grid.x, car.pos.z - grid.z)).toBeLessThan(0.05);
      // ...and one gone bad between ticks, at the next tick
      drive(2, (c) => inp({ throttle: cruise(c, 15) }));
      lc(car).vehicle.velocity.x = Number.NaN;
      drive(DT, () => inp());
      expect(finite(car)).toBe(true);
      expect(Math.hypot(car.pos.x - grid.x, car.pos.z - grid.z)).toBeLessThan(0.05);
    });

    it('shifts by hand (every queued press in turn), refuses a downshift that would over-rev, has a neutral, and reverses on the brake', async () => {
      const { car, drive } = await session(id, { walls: false });
      car.forceSurface = S_ASPHALT;
      car.manual = true;
      const manual = (o: Partial<DriveInput>) => inp({ autoGears: false, ...o });
      // Three quick presses are three gears, each waiting for the shift before it (the engine keeps only one press
      // while it shifts); then back down to second the same way
      let rpmPerMs = 0;
      drive(10, (c) => { if (c.speedF > 12) rpmPerMs = c.rpm / c.speedF; return manual({ throttle: cruise(c, 15) }); }, () => car.speedF > 14);
      expect(car.gear).toBe(1);
      car.pendingShift = 2;
      drive(2 * DT, () => manual({ throttle: 0.3 }));
      expect([car.gear, car.pendingShift]).toEqual([2, 1]);
      car.pendingShift++;
      drive(0.5, () => manual({ throttle: 0.3 }));
      expect([car.gear, car.pendingShift]).toEqual([4, 0]);
      car.pendingShift = -2;
      drive(0.5, () => manual({ throttle: 0.3 }));
      expect([car.gear, car.pendingShift, car.shiftDenied]).toEqual([2, 0, false]);
      // Second gear, faster than first can rev to (redline plus the box's margin, 500 rpm on the GT3, -200 on the F1)
      const margin = lc(car).spec.config.gearbox.downshift?.overRevRpm ?? -200, limit = (car.spec.redline + margin) / rpmPerMs;
      drive(15, () => manual({ throttle: 0.5 }), () => car.speedF > limit * 1.05);
      expect(car.gear).toBe(2);
      car.pendingShift = -1;
      drive(DT, () => manual({ throttle: 0.5 }));
      expect([car.gear, car.shiftDenied, car.pendingShift]).toEqual([2, true, 0]);
      car.shiftDenied = false;
      drive(10, () => manual({ brake: 0.3 }), () => car.speedF < limit * 0.8);
      car.pendingShift = -1;
      drive(0.2, () => manual({ brake: 0.3 }));
      expect([car.gear, car.shiftDenied]).toEqual([1, false]);

      // Neutral is below first, at any speed: the car coasts and the engine revs free. Reverse is below neutral, only
      // at a standstill, and the brake held in neutral does not select it. Up from reverse: neutral, then first.
      car.pendingShift = -1;
      drive(0.3, () => manual({}));
      expect(car.gear).toBe(0);
      const coasting = car.speedF;
      drive(1, () => manual({ throttle: 1 }));
      expect(car.speedF).toBeLessThan(coasting);
      expect(car.rpm).toBeGreaterThan(car.spec.redline * 0.8);
      car.pendingShift = -1;
      drive(0.2, () => manual({}));
      expect([car.gear, car.pendingShift]).toEqual([0, 0]);
      drive(10, () => manual({ brake: 0.5 }), () => Math.abs(car.speedF) < 0.1);
      drive(1, () => manual({ brake: 1 }));
      expect(car.gear).toBe(0);
      car.pendingShift = -1;
      drive(0.3, () => manual({}));
      expect(car.gear).toBe(-1);
      car.pendingShift = 1;
      drive(0.3, () => manual({}));
      expect(car.gear).toBe(0);
      car.pendingShift = 1;
      drive(0.3, () => manual({}));
      expect(car.gear).toBe(1);

      // Reverse: hold the brake at a standstill, then the brake drives backwards and the throttle brakes; the throttle
      // near a standstill selects first again
      car.manual = false;
      drive(10, () => inp({ brake: 0.4 }), () => car.speedF < 0.1);
      drive(0.3, () => inp({ brake: 1 }));
      expect(car.gear).toBe(1);
      let revved = false;                                  // the brake stays the brake until the engine is in reverse
      drive(0.2, () => inp({ brake: 1 }), () => { revved ||= car.gear > 0 && car.throttle > 0; return false; });
      expect([car.gear, revved]).toEqual([-1, false]);
      const from = car.pos.clone();
      drive(2, () => inp({ brake: 0.3 }));
      expect(car.speedF).toBeLessThan(-3);
      expect(car.pos.distanceTo(from)).toBeGreaterThan(3);
      expect([car.throttle, car.brake]).toEqual([0.3, 0]);   // as applied: the brake pedal is the throttle in reverse
      let slowed = false;
      drive(4, () => inp({ throttle: 0.3 }), () => { slowed ||= car.gear === -1 && car.brake === 0.3; return car.gear === 1; });
      expect(slowed).toBe(true);
      expect(car.speedF).toBeGreaterThan(-1);
      drive(2, () => inp({ throttle: 0.3 }));
      expect([car.gear, car.speedF > 1]).toEqual([1, true]);
    });

    it('counts the time on its side, and the session puts it back', async () => {
      const { car, drive } = await session(id);
      const v = lc(car).vehicle, side = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const pose = v.quaternion.clone().multiply(side), y = v.position.y + 2;
      // held on its side at rest, clear of the ground: the engine has no body against the ground, and a car whose
      // wheels' probes meet the road sideways is thrown about
      const hold = () => { v.quaternion.copy(pose); v.position.y = y; v.velocity.set(0, 0, 0); v.angularVelocity.set(0, 0, 0); return inp(); };
      drive(1, hold);
      expect(car.up.y).toBeLessThan(0.3);
      expect(car.tipped).toBeCloseTo(1, 1);
      expect(needsReset(car)).toBe(false);
      drive(0.6, hold, () => car.tipped === 0);
      expect(car.up.y).toBeGreaterThan(0.999);   // put back on its wheels
    });

    it('reports its wheels: out past the limits, slip near zero rolling and past 1 sliding', async () => {
      const { car, track, drive } = await session(id, { walls: false });
      car.forceSurface = S_ASPHALT;
      let rolling = 0;
      drive(10, (c) => inp({ throttle: cruise(c, 20) }), () => car.speedF > 19.5);
      drive(1, (c) => { rolling = Math.max(rolling, ...c.wheels.map((w) => w.slip)); return inp({ throttle: cruise(c, 20) }); });
      expect(rolling).toBeLessThan(0.25);
      expect(car.wheels.every((w) => w.grounded && Math.abs(w.contact.y) < 0.01)).toBe(true);
      drive(0.3, () => inp({ brake: 1 }));                 // full brake: the ABS works the fronts at and past their peak slip
      expect(Math.min(car.wheels[0].slip, car.wheels[1].slip)).toBeGreaterThan(1);
      // out: all four wheels past the track limit
      const s = track.S[track.N - 80];
      car.placeAt(s, track.WL[track.N - 80] + KERB_W + 2.5);
      expect(car.wheels.every((w) => w.out)).toBe(true);
      car.placeAt(s, 0);
      expect(car.wheels.some((w) => w.out)).toBe(false);
    });

    it('renders between ticks, with the wheels on their hubs and the fronts steered', async () => {
      const { car, drive } = await session(id, { walls: false });
      drive(3, (c) => inp({ throttle: cruise(c, 10), steerAngle: 0.1 }));
      const m = car.mesh, mid = new THREE.Vector3().lerpVectors(car.prevPos, car.pos, 0.5);
      expect(car.prevPos.distanceTo(car.pos)).toBeGreaterThan(0.05);
      car.render(0.5, DT);
      expect(m.root.position.distanceTo(mid)).toBeLessThan(1e-9);
      const spin = m.wheels.map((w) => w.spinner.rotation.x);
      const hubY = car.spec.wheelRadius - car.spec.comHeight;
      for (const [k, w] of m.wheels.entries()) {
        expect(Math.abs(w.pivot.position.y - hubY)).toBeLessThan(0.04);
        expect(Math.sign(w.pivot.position.x)).toBe(k % 2 === 0 ? 1 : -1);   // FL, FR, RL, RR: + x is left
        expect(Math.sign(w.pivot.position.z)).toBe(k < 2 ? 1 : -1);
        expect(Math.abs(w.pivot.rotation.y - (k < 2 ? car.steer : 0))).toBeLessThan(k < 2 ? 0.02 : 0.005);
      }
      expect(car.steer).toBeGreaterThan(0.08);
      drive(DT, (c) => inp({ throttle: cruise(c, 10), steerAngle: 0.1 }));
      car.render(1, DT);
      expect(m.root.position.equals(car.pos)).toBe(true);
      m.wheels.forEach((w, k) => expect(w.spinner.rotation.x).not.toBe(spin[k]));
    });

    it('is deterministic: the same inputs give bit-identical state', async () => {
      const run = async () => {
        const { car, drive } = await session(id);
        drive(4, (c, t) => inp({ throttle: t < 2.5 ? cruise(c, 25, 0.6) : 0, brake: t < 2.5 ? 0 : 0.3, steerAngle: 0.05 * Math.sin(2 * t) }));
        const v = lc(car).vehicle;
        return [...car.pos.toArray(), ...car.quat.toArray(), ...car.vel.toArray(), ...car.angv.toArray(), car.rpm, car.gear, car.steer,
          v.engineOmega, v.ersEnergyJ, ...v.wheels.flatMap((w) => [w.omega, w.hubY, w.slipRatio, w.surfaceTempC, w.brakeDisc.surfaceTempC])];
      };
      const a = await run(), b = await run();
      expect(a.every(Number.isFinite)).toBe(true);
      expect(a.every((x, i) => Object.is(x, b[i]))).toBe(true);
    });

    it('runs exactly 25 engine steps every 6 ticks, and leaves the scene when destroyed', async () => {
      const { car, drive } = await session(id);
      const v = lc(car).vehicle, step = v.step.bind(v);
      let calls = 0, stepped = 0;
      v.step = (dt, i) => { step(dt, i); calls++; stepped += v.lastStepTimeS; };
      drive(5, (c) => inp({ throttle: cruise(c, 15) }));
      expect(calls).toBe(2500);                         // 600 ticks at 120 Hz: 5 s of 500 Hz steps
      expect(stepped).toBeCloseTo(5, 9);
      expect(v.unsteppedS).toBe(0);                     // each call ran exactly one 2 ms step
      expect(VehiclePhysics.FIXED_DT).toBe(0.002);
      car.destroy();
      expect(car.mesh.root.parent).toBeNull();
    });
  });
}
