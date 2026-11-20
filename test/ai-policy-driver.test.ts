import { describe, expect, it } from 'vitest';
import type { CarId } from '../src/cars';
import { END_REASONS, INFO, RaceEnv } from '../src/ai/env';
import { parsePolicy, type Policy } from '../src/ai/policy';
import { PolicyDriver } from '../src/ai/policyDriver';
import { session } from './harness';
import { fileBuffer, gamePolicy } from './policies';

// A trained policy driving the game's Session (src/ai/policyDriver.ts) does exactly what it does in the RL
// environment: the same observations at every policy step and the same car, bit for bit, from the same flying start.
// The game's policy for the lcf1 at Melbourne (public/ai/, through the manifest), and a random-weights fixture that
// drives the drift car and the GT3 into the walls (the wall sensor on both engines, and the end of an episode).

// Steps the environment (evaluation start: the game's flying start) and the game's Session side by side for up to
// `seconds`, comparing every observation the policy is given; stops where the environment's episode ends.
async function sideBySide(policy: Policy, car: CarId, seconds: number) {
  const env = await RaceEnv.create({ ...policy.env, reset: { cars: [car], tracks: ['melbourne'] } });
  env.reset({ eval: true });
  const { session: s, car: c } = await session(car, { flying: true, tc: policy.env.tc });
  const drv = new PolicyDriver(policy, s), act = new Float32Array(2), before = new Float32Array(policy.obsDim);
  let steps = 0, walls = 0, mismatch = -1;
  for (; steps < seconds * policy.env.actionHz; steps++) {
    before.set(env.obs);
    policy.run(env.obs, act);
    const r = env.step(act[0], act[1]);
    for (let k = 0; k < env.ticksPerAction; k++) {
      s.tick(drv.input(), false);
      // the driver observed the car at the step's first tick: what the environment's policy was given
      if (k === 0 && mismatch < 0 && !(drv.obs.every((v, i) => Object.is(v, before[i])) && drv.action.every((v, i) => Object.is(v, act[i])))) mismatch = steps;
    }
    walls += env.info[INFO.wall_contact];
    if (r.terminated || r.truncated) break;
  }
  return { env, s, drv, c, steps, walls, mismatch };
}

describe('a policy in the game', () => {
  it('drives the Session exactly as the environment drives its car', async () => {
    const { policy } = gamePolicy('lcf1', 'melbourne');
    const { env, s, drv, c, steps, mismatch } = await sideBySide(policy, 'lcf1', 25);
    expect(steps).toBe(500);
    expect(mismatch).toBe(-1);
    expect(drv.steps).toBe(500);
    // the car itself, bit for bit
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Object.is(c.pos[k], env.car.pos[k])).toBe(true);
      expect(Object.is(c.vel[k], env.car.vel[k])).toBe(true);
    }
    expect(c.speedF * 3.6).toBeGreaterThan(80);   // (it is driving, not parked)
    expect(s.timing.lapStart).not.toBeNull();     // over the line by now: 25 s
    // a restart puts the car back at the start spot, and the driver starts afresh: the environment's first observation
    s.restart();
    s.tick(drv.input(), false);
    expect(drv.steps).toBe(1);
    env.reset({ eval: true });
    expect([...drv.obs]).toEqual([...env.obs]);
  });

  for (const car of ['drift', 'lcgt3'] as CarId[]) {
    it(`and into the walls in the ${car} (random weights), to the end of the episode`, async () => {
      const policy = parsePolicy(fileBuffer('test/fixtures/policy-simba.bin'));
      const { steps, mismatch, env, walls, drv } = await sideBySide(policy, car, 30);
      console.log(`${car}: ${steps + 1} steps, ${walls} touching a wall, end ${END_REASONS[env.info[INFO.end_reason]]}`);
      expect(mismatch).toBe(-1);
      expect(walls).toBeGreaterThan(0);   // (the wall sensor and its observation were in play)
      expect(drv.steps).toBe(steps + 1);
    });
  }
});
