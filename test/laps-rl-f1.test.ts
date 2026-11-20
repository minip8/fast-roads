import { expect, it } from 'vitest';
import { PolicyDriver } from '../src/ai/policyDriver';
import { session } from './harness';
import { gamePolicy, noGamePolicy } from './policies';

// The game's trained policy for the lcf1 at Melbourne (public/ai/) laps the game's Session from the flying start, as
// test/laps.ts does for the autopilot: a valid lap, no resets, in the time the trainer's evaluation gave that policy
// (its file's provenance). The trainer ran it with float32 inference in torch or numpy and the game runs it in
// TypeScript (policy.ts): actions agree to about 1e-6, but a lap is long enough for that to move the line a little.
// Skipped while the manifest names no policy there.
it('a trained policy laps Melbourne in the lcf1 as the trainer evaluated it', async (ctx) => {
  const found = gamePolicy('lcf1', 'melbourne');
  if (!found) return ctx.skip(noGamePolicy('lcf1', 'melbourne'));
  const { file, policy } = found;
  const ev = (policy.meta.provenance.eval as { track: string; car: string; lap_time: number | null; lap_valid: boolean }[] | undefined)
    ?.find((r) => r.track === 'melbourne' && r.car === 'lcf1');
  if (!ev?.lap_time || !ev.lap_valid) throw new Error(`${file} has no valid evaluated lap at Melbourne in its provenance`);
  const { timing, drive, session: s } = await session('lcf1', { flying: true, tc: policy.env.tc });
  const drv = new PolicyDriver(policy, s);
  let resets = 0;
  s.onReset = () => { resets++; };
  drive(ev.lap_time + 40, () => drv.input(), () => timing.laps.length > 0);
  const lap = timing.laps[0];
  console.log(`${file}: ${lap?.time.toFixed(3)} s in the game, ${ev.lap_time.toFixed(3)} s in the trainer's evaluation`);
  expect(lap?.valid).toBe(true);
  expect(resets).toBe(0);
  expect(Math.abs(lap.time - ev.lap_time)).toBeLessThan(0.5);
});
