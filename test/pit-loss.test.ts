// A tool, skipped unless PITLOSS is set: `PITLOSS=melbourne npx vitest run test/pit-loss.test.ts` prints the time a
// pit stop costs each car at that circuit (docs/net.md quotes Melbourne's). The autopilot drives from the start spot
// to 300 m past the pit lane's end twice: once on the track, once through the lane with a stop in the box (braking
// for the lane's limit before its entry, the limiter, the service), in a room's lobby (dry, the room's wear).
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import type { CarId } from '../src/cars';
import { DT } from '../src/config';
import { Multiplayer } from '../src/multiplayer';
import { NetClient } from '../src/net';
import { LoopbackNet } from '../src/net/loopback';
import { laneDist } from '../src/raceGeometry';
import { TRACKS, type TrackId } from '../src/tracks';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { Relay } from '../server/relay';
import { session } from './harness';

const CIRCUIT = (process.env.PITLOSS ?? '') as TrackId;

describe.skipIf(!process.env.PITLOSS)('pit stop time loss', () => {
  for (const id of ['lcf1', 'lcgt3', 'drift'] as CarId[]) test(id, async () => {
    const net = new LoopbackNet(1), relay = new Relay({ now: () => net.now }), pair = net.pair({ latency: 0.01, jitter: 0, loss: 0, duplicate: 0 });
    relay.accept(pair.server);
    const h = await session(id, { flying: true, track: CIRCUIT });
    const nc = new NetClient(pair.client, { room: 'PIT', name: 'P', car: id, mode: 'create', circuit: CIRCUIT, clock: () => net.now });
    const mp = new Multiplayer(nc, h.session, TRACKS[CIRCUIT]), w = mp.weekend, lane = w.lane, tr = h.track, s = h.session;
    let t = 0;
    const step = (drv: (car: Vehicle) => DriveInput) => {
      t += DT; net.advance(t); if (Math.round(t / DT) % 120 === 0) relay.update();
      mp.update(t); mp.tick(drv(s.car), false, t);
    };
    for (let k = 0; k < 120; k++) step((c) => autopilot(c, tr));
    // from the start spot to 300 m past the lane's end
    const goal = lane.len + 300;
    const run = (drv: (car: Vehicle) => DriveInput) => {
      s.restart();
      const t0 = s.simTime;
      for (let k = 0; k < 120 * 120; k++) {
        step(drv);
        const d = laneDist(lane, tr, s.car.proj.s);
        if (d > goal - 5 && d < goal + 50) return s.simTime - t0;
      }
      throw new Error('never got there');
    };
    const track = run((c) => autopilot(c, tr));
    const ds = tr.L / tr.N;
    const pit = run((c) => {
      const d = laneDist(lane, tr, c.proj.s), before = d > tr.L - 400 ? d - tr.L : null;
      let lat = 0, vmax = Infinity;
      if (d <= lane.len) {
        const k = Math.min(lane.n - 1, Math.round(d / ds)), mid = lane.side * (lane.inner[k] + lane.outer[k]) / 2;
        const f = d < lane.limIn ? d / lane.limIn : d > lane.limOut ? Math.max(0, 1 - (d - lane.limOut) / (lane.len - lane.limOut)) : 1;
        lat = mid * Math.min(1, f * 1.5);
        if (!w.pit.stopped) vmax = Math.min(lane.limitMs, Math.sqrt(2 * 5 * Math.max(0, lane.box - d)) + 0.3);
      }
      if (before != null) vmax = Math.sqrt(lane.limitMs ** 2 + 2 * 9 * 0.8 * (lane.limIn - before));
      const inp = autopilot(c, tr, lat), v = c.speedF;
      if (v > vmax + 0.3) return { ...inp, throttle: 0, brake: v > 0.3 ? 1 : 0 };
      if (v > vmax - 1) return { ...inp, throttle: 0, brake: 0 };
      // (off the track the autopilot lifts, as it does near an edge: in the lane the limiter is what holds it)
      return d <= lane.len ? { ...inp, throttle: 1, brake: 0 } : inp;
    });
    expect(w.pit.stops).toBe(1);
    console.log(`${CIRCUIT} ${id}: through the pits with a ${s.car.spec.race.pitSecs} s stop ${pit.toFixed(2)} s, on the track ${track.toFixed(2)} s: a stop costs ${(pit - track).toFixed(1)} s`);
  }, 120_000);
});
