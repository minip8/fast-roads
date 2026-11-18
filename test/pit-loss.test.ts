// A tool, skipped unless PITLOSS is set: `PITLOSS=melbourne npx vitest run test/pit-loss.test.ts` prints the time a
// pit stop costs each car at that circuit (docs/net.md quotes Melbourne's). The autopilot drives from the start spot
// to 300 m past the pit lane's end twice: once on the track, once through the lane with a stop in the box (its pit
// plan: braking for the limit line, the limiter, braking to a stop in the box, the service), in a room's lobby (dry,
// the room's wear).
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import type { CarId } from '../src/cars';
import { DT } from '../src/config';
import { Multiplayer } from '../src/multiplayer';
import { NetClient } from '../src/net';
import { LoopbackNet } from '../src/net/loopback';
import { laneLapS } from '../src/pitLane';
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
    // from the start spot to 300 m past the lane's end (m along the lap from the start spot)
    const L = tr.L, from = s.startS, goal = ((laneLapS(lane, L, lane.len) + 300 - from) % L + L) % L;
    const run = (drv: (car: Vehicle) => DriveInput) => {
      s.restart();
      const t0 = s.simTime;
      for (let k = 0; k < 120 * 180; k++) {
        step(drv);
        const d = ((s.car.proj.s - from) % L + L) % L;
        if (d > goal - 5 && d < goal + 50) return s.simTime - t0;
      }
      throw new Error('never got there');
    };
    const track = run((c) => autopilot(c, tr));
    w.setPitRequest(true);
    const pit = run((c) => autopilot(c, tr, 0, w.pitPlan));
    expect(w.pit.stops).toBe(1);
    console.log(`${CIRCUIT} ${id}: through the pits with a ${s.car.spec.race.pitSecs} s stop ${pit.toFixed(2)} s, on the track ${track.toFixed(2)} s: a stop costs ${(pit - track).toFixed(1)} s`);
  }, 120_000);
});
