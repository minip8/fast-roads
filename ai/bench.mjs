#!/usr/bin/env node
// Throughput of the RL environment worker (build/env/worker.mjs: npm run build:env first), through the protocol:
// env steps per second per process for each car, the cost of a reset, and how the total scales with processes.
// The cars are driven by the autopilot (NaN actions), so they lap cleanly and no time goes on unplanned resets.
//
//   node ai/bench.mjs [seconds per measurement, default 8] [max processes, default the core count]
import { availableParallelism } from 'node:os';
import { EnvWorker } from './client.mjs';

const secs = Number(process.argv[2] ?? 8), cores = availableParallelism(), maxP = Number(process.argv[3] ?? cores);
const CARS = ['lcf1', 'lcgt3', 'drift'];

async function start(n, cars, seed) {
  const w = new EnvWorker();
  await w.hello();
  await w.init(n, seed, { episodeSecs: 1e6, reset: { tracks: ['melbourne'], cars } });
  await w.reset({ start: 'flying' });
  return w;
}
// steps all workers in lockstep-free loops for `secs`, returns env steps per second summed over them
async function run(workers, seconds) {
  const t0 = performance.now();
  const counts = await Promise.all(workers.map(async (w) => {
    const a = new Float32Array(w.n * 2).fill(Number.NaN);
    let steps = 0;
    while (performance.now() - t0 < seconds * 1000) { await w.step(a); steps += w.n; }
    return steps;
  }));
  return counts.reduce((a, b) => a + b, 0) / ((performance.now() - t0) / 1000);
}

console.log(`${cores} logical cores, node ${process.version}, ${secs} s per measurement, 20 Hz actions (6 physics ticks each)`);
console.log('\nOne process, one car:');
for (const car of CARS) {
  for (const n of [1, 8]) {
    const w = await start(n, [car], 1);
    const sps = await run([w], secs);
    console.log(`  ${car.padEnd(6)} N=${n}: ${sps.toFixed(0).padStart(5)} env steps/s (${(sps * 6).toFixed(0)} physics ticks/s, ${(1000 / sps).toFixed(2)} ms per env step)`);
    await w.close();
  }
}

console.log('\nReset (one env, random start, round trip):');
for (const car of CARS) {
  const w = await start(1, [car], 2);
  const times = [];
  for (let k = 0; k < 20; k++) { const t = performance.now(); await w.reset({ car, seed: 100 + k }); times.push(performance.now() - t); }
  const ft = [];
  for (let k = 0; k < 10; k++) { const t = performance.now(); await w.reset({ car, start: 'flying' }); ft.push(performance.now() - t); }
  times.sort((a, b) => a - b); ft.sort((a, b) => a - b);
  console.log(`  ${car.padEnd(6)} random start: median ${times[10].toFixed(1)} ms (max ${times[19].toFixed(1)}), flying start: median ${ft[5].toFixed(1)} ms`);
  await w.close();
}
// changing circuit: a new physics world for it once the environment's cached ones (cacheSessions, 2) are in use
{
  const tracks = ['melbourne', 'monaco', 'monza', 'spa', 'suzuka'], w = new EnvWorker();
  await w.hello();
  await w.init(1, 3, { reset: { tracks, cars: CARS } });
  for (const track of tracks) await w.reset({ track });   // circuits built once per process: not what is timed
  const times = [];
  for (let k = 0; k < 20; k++) { const t = performance.now(); await w.reset({ track: tracks[k % 5], seed: k }); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  console.log(`  another circuit each reset (cars mixed): median ${times[10].toFixed(1)} ms (max ${times[19].toFixed(1)})`);
  await w.close();
}

console.log('\nScaling: P processes x 4 envs (cars mixed), total env steps/s:');
for (const P of [1, 2, 4, 6, 8, 10, 12, 16].filter((p) => p <= maxP)) {
  const workers = await Promise.all(Array.from({ length: P }, (_, k) => start(4, CARS, 10 * k)));
  const sps = await run(workers, secs);
  console.log(`  P=${String(P).padStart(2)}: ${sps.toFixed(0).padStart(6)} env steps/s (${(sps / P).toFixed(0)} per process)`);
  await Promise.all(workers.map((w) => w.close()));
}
