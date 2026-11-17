// A room of game Sessions joined to an in-process relay over the emulated network (the relay's durations shortened:
// a settings minute is 4 s, the grid 1 s), every client simulating its own car as the game does. Laps can be driven by
// putting the car just before each timing line in turn (hopLap: a lap of a few seconds; the relay takes laps from
// 1 s here), the rest by the autopilot. Shared by race-weekend.test.ts and oneshot.test.ts.
import { autopilot } from '../src/autopilot';
import type { CarId } from '../src/cars';
import { DT } from '../src/config';
import { Multiplayer } from '../src/multiplayer';
import { NetClient } from '../src/net';
import { type LinkConditions, LoopbackNet } from '../src/net/loopback';
import { seededRandom } from '../src/net/weather';
import type { Session } from '../src/sim';
import { TRACKS } from '../src/tracks';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { Relay, type RelayOptions } from '../server/relay';
import { session } from './harness';

export const LINK: LinkConditions = { latency: 0.03, jitter: 0.005, loss: 0.01, duplicate: 0 };
export const FAST: Partial<RelayOptions> = {
  minLapSecs: 1, minute: 4, gridSecs: 1, lightsHold: [0.2, 0.4], resultsSecs: 2, overtimeSecs: 3, oneShotPrep: 1, oneShotLimit: 30,
  pitSpacing: 1, missedStopPenalty: 60,
};
export type Driver = (car: Vehicle, t: number) => DriveInput;
export const full: Driver = () => ({ throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true });
export const DEF = TRACKS.melbourne;

export interface Client { name: string; s: Session; mp: Multiplayer; driver: Driver | null }

export class Room {
  net = new LoopbackNet(3);
  relay: Relay;
  clients: Client[] = [];
  t = 0;
  private lastRelay = 0;
  private due: number | null = null;
  idle: ((c: Client) => boolean) | null = null;
  constructor(opt: Partial<RelayOptions> = {}) {
    this.relay = new Relay({ ...FAST, random: seededRandom(9), schedule: (at) => { this.due = at; }, ...opt, now: () => this.net.now });
  }
  async join(name: string, car: CarId, mode: 'create' | 'join' = 'join') {
    const h = await session(car, { flying: true });
    const pair = this.net.pair(LINK, LINK);
    this.relay.accept(pair.server);
    const net = new NetClient(pair.client, { room: 'RACE', name, car, mode, circuit: 'melbourne', clock: () => this.net.now });
    const c: Client = { name, s: h.session, mp: new Multiplayer(net, h.session, DEF), driver: null };
    this.clients.push(c);
    for (let k = 0; k < 240 && net.status !== 'joined'; k++) this.run(DT);
    return c;
  }
  run(seconds: number, every?: () => void) {
    for (let k = 0, n = Math.round(seconds / DT); k < n; k++) {
      this.t += DT;
      this.net.advance(this.t);
      if (this.t - this.lastRelay >= 1 || (this.due != null && this.t >= this.due)) { this.relay.update(); this.lastRelay = this.t; }
      for (const c of this.clients) {
        if (c.mp.net.status === 'closed') continue;
        c.mp.update(this.t, false);
        if (this.idle?.(c)) { c.mp.idle(this.t); continue; }   // (a test's shortcut: a car with nothing to do, not simulated)
        c.mp.tick(c.driver ? c.driver(c.s.car, c.s.simTime) : autopilot(c.s.car, c.s.track), !c.driver, this.t);
      }
      every?.();
    }
  }
  until(cond: () => boolean, max: number, what: string) {
    for (let k = 0, n = Math.round(max / DT); k < n; k++) { if (cond()) return; this.run(DT); }
    throw new Error(`timed out waiting for ${what}`);
  }
  // a lap from wherever the car is: just before the line, then each sector line, then the line again, `gap` s apart
  hopLap(c: Client, gap: number, first = true) {
    const lines = c.s.timing.lines;
    for (const k of first ? [0, 1, 2, 0] : [1, 2, 0]) { hop(c, lines[k].s); this.run(gap); }
  }
}
// the car 3 m before track position s, on the middle of the road, at 25 m/s
export const hop = (c: Client, s: number) => c.s.car.placeAt(((s - 3) % c.s.track.L + c.s.track.L) % c.s.track.L, 0, 25);
export const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

