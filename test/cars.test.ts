// Every car has what the rest of the game needs from its spec. (The compiler checks the fields exist; this checks
// they fit together.) Construction only, no driving: the lap tests drive each car.
import { describe, expect, it } from 'vitest';
import { buildSpeedProfile } from '../src/autopilot';
import { CARS } from '../src/cars';
import { SETTING_DEFS } from '../src/settings';
import { ourSpec, session } from './harness';

describe.each(Object.entries(CARS))('%s', (key, spec) => {
  it('is listed under its own id, with its own best-times key, in the Car menu', () => {
    expect(spec.id).toBe(key);
    expect(Object.values(CARS).filter((c) => c.storeKey === spec.storeKey)).toHaveLength(1);
    expect(SETTING_DEFS.car.options).toContainEqual([spec.id, spec.name]);
    expect(spec.blurb.length).toBeGreaterThan(0);
    expect(spec.powerKw).toBeGreaterThan(0);
  });

  it('has consistent shift lights and an engine voice', () => {
    expect(spec.idle).toBeLessThan(spec.shiftLightsFrom);
    expect(spec.shiftLightsFrom).toBeLessThan(spec.shiftPoint);
    expect(spec.shiftPoint).toBeLessThan(spec.redline);
    expect(spec.sound.firingDiv).toBeGreaterThan(0);
    expect(spec.sound.harmonics.length).toBeGreaterThan(0);
  });

  // Our physics' own numbers (cars on another engine bring their own).
  it.runIf(spec.physics === 'rapier')('has a consistent engine and gearbox', () => {
    const ours = ourSpec(spec), rpms = ours.torque.map(([rpm]) => rpm);
    expect(rpms).toEqual([...rpms].sort((a, b) => a - b));
    expect(ours.gearTop.slice(1)).toEqual([...ours.gearTop.slice(1)].sort((a, b) => a - b));
    expect(ours.redline).toBeLessThan(ours.overRev);
  });

  it('builds a body with four wheels, and an autopilot plan', async () => {
    const { car, track } = await session(spec.id);
    expect(car.mesh.wheels).toHaveLength(4);
    expect(car.mesh.root.parent).not.toBeNull();   // added to the scene
    expect(buildSpeedProfile(track, spec).every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });
});
