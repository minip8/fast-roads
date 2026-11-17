// Multiplayer end to end (src/multiplayer.ts): game Sessions in one process, each joined through its own NetClient to
// an in-process relay over the emulated network (LoopbackNet: latency, jitter, loss), every client simulating only
// its own car and seeing the others as proxies, exactly as the game runs them. NET_REPORT=1 prints the measurements.
import { describe, expect, test } from 'vitest';
import { autopilot } from '../src/autopilot';
import { CARS, type CarId } from '../src/cars';
import { TRACKS } from '../src/tracks';
import { fmtTime } from '../src/util';
import { DT } from '../src/config';
import { CLEAR_SECS, Multiplayer } from '../src/multiplayer';
import { NetClient, STATE_FLAG } from '../src/net';
import { type LinkConditions, LoopbackNet } from '../src/net/loopback';
import type { Session } from '../src/sim';
import type { DriveInput, Vehicle } from '../src/vehicle';
import { Relay } from '../server/relay';
import { session } from './harness';

const LINK: LinkConditions = { latency: 0.04, jitter: 0.01, loss: 0.02, duplicate: 0.005 };
const report = (...a: unknown[]) => { if (process.env.NET_REPORT) console.log(...a); };
type Driver = (car: Vehicle, t: number) => DriveInput;
const coast: Driver = () => ({ throttle: 0, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true });
const full: Driver = () => ({ throttle: 1, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true });

interface Client { name: string; s: Session; mp: Multiplayer; driver: Driver | null; ticking: boolean; onTick?: () => void }

// A relay and its clients, all ticked in lockstep at 120 Hz on the loopback clock.
class Room {
  net = new LoopbackNet(7);
  relay = new Relay({ minLapSecs: 5, now: () => this.net.now });
  clients: Client[] = [];
  t = 0;
  private lastRelay = 0;

  // A client in its own Session. flying: at the circuit's start spot (as the game starts); otherwise at rest on
  // Melbourne's start straight. driver null: the autopilot.
  async join(name: string, car: CarId, { flying = true, driver = null as Driver | null, link = LINK } = {}) {
    const h = await session(car, { flying });
    const pair = this.net.pair(link, link);
    this.relay.accept(pair.server);
    const net = new NetClient(pair.client, { room: 'TEST', name, car, circuit: 'melbourne', clock: () => this.net.now });
    const c: Client = { name, s: h.session, mp: new Multiplayer(net, h.session, TRACKS.melbourne), driver, ticking: true };
    this.clients.push(c);
    return c;
  }

  run(seconds: number, every?: () => void) {
    for (let k = 0, n = Math.round(seconds / DT); k < n; k++) {
      this.t += DT;
      this.net.advance(this.t);
      if (this.t - this.lastRelay >= 1) { this.relay.update(); this.lastRelay = this.t; }
      for (const c of this.clients) {
        if (c.mp.net.status === 'closed') continue;
        c.mp.update(this.t, !c.ticking);
        if (!c.ticking) { c.mp.idle(this.t); continue; }
        const car = c.s.car;
        c.mp.tick(c.driver ? c.driver(car, c.s.simTime) : autopilot(car, c.s.track), !c.driver, this.t);
        c.onTick?.();
      }
      every?.();
    }
  }
  // until every client has joined and sees all the others
  settle() {
    for (let k = 0; k < 600 && !this.clients.every((c) => c.mp.connected && c.mp.players.size === this.clients.length - 1); k++) this.run(DT);
  }
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))];
const flags = (c: Client, other: Client) => [...c.mp.players.values()].find((p) => p.info.name === other.name)!;

describe('multiplayer sessions over the emulated network', () => {
  test('proxies appear and track the real cars (40 ms + 0-10 ms each way, 2% loss)', async () => {
    const room = new Room();
    const a = await room.join('Alice', 'lcf1'), b = await room.join('Bob', 'lcgt3');
    room.settle();
    expect(a.mp.players.size).toBe(1); expect(b.mp.players.size).toBe(1);
    // Bob 300 m up the road from the start spot, so the two never meet
    b.s.car.placeAt(b.s.track.L - TRACKS.melbourne.startBack + 300, 0, 40);
    const errA: number[] = [], errB: number[] = [];
    room.run(1);   // the clocks settle (pings every 0.5 s at first) and the proxies fill
    room.run(10, () => {
      for (const [me, them, err] of [[a, b, errA], [b, a, errB]] as const) {
        const p = [...me.mp.players.values()][0];
        if (p.hasSample) err.push(dist(p.body, them.s.car.pos));
      }
    });
    const all = [...errA, ...errB], mean = all.reduce((x, y) => x + y, 0) / all.length;
    report(`proxy error at the tick's time: mean ${mean.toFixed(3)} m, p95 ${pct(all, 0.95).toFixed(3)} m, max ${Math.max(...all).toFixed(3)} m (${all.length} samples; speeds to ${Math.round(Math.max(a.s.car.speedF, b.s.car.speedF) * 3.6)} km/h)`);
    expect(all.length).toBeGreaterThan(2 * 10 * 120 * 0.99);
    expect(mean).toBeLessThan(0.3);
    expect(pct(all, 0.95)).toBeLessThan(0.8);
    expect(Math.max(...all)).toBeLessThan(2.5);
    // apart all along: both collidable, no contacts
    for (const c of [a, b]) { expect(c.mp.noCollide).toBe(false); expect(c.mp.stats.contactTicks).toBe(0); }
    expect([...a.mp.players.values()][0].collidable).toBe(true);
  });

  // Alice (behind, full throttle) runs into Bob (ahead, coasting) on Melbourne's start straight.
  async function rearEnd(missOnBob: boolean) {
    const room = new Room();
    const a = await room.join('Alice', 'lcgt3', { flying: false, driver: full });
    const b = await room.join('Bob', 'lcgt3', { flying: false, driver: coast });
    const s0 = a.s.track.L - 160;
    b.s.car.placeAt(s0 + 30, 0, 0);
    b.mp.localCollisions = !missOnBob;
    room.settle();
    room.run(CLEAR_SECS + 0.2);
    for (const c of [a, b]) expect(c.mp.noCollide).toBe(false);
    // momentum each client's own car received, from its own contacts and from applied events
    // momentum change over the ticks with a contact (or an applied event) on that client: the hit, plus a tick's
    // worth of tyre force each time (small beside it)
    const mom = (c: Client) => ({ x: c.s.car.vel.x * c.s.car.shape.mass, z: c.s.car.vel.z * c.s.car.shape.mass });
    let hitAt = -1, worstUp = 1, worstVy = 0;
    const dA = { x: 0, z: 0 }, dB = { x: 0, z: 0 };
    const track = (c: Client, d: { x: number; z: number }) => {
      let last = mom(c), lastApplied = 0, lastTicks = 0;
      c.onTick = () => {
        const now = mom(c), st = c.mp.stats;
        if (st.contactTicks !== lastTicks || st.eventsApplied !== lastApplied) {
          d.x += now.x - last.x; d.z += now.z - last.z;
          if (hitAt < 0) hitAt = room.t;
        }
        lastTicks = st.contactTicks; lastApplied = st.eventsApplied; last = now;
        worstUp = Math.min(worstUp, c.s.car.up.y); worstVy = Math.max(worstVy, Math.abs(c.s.car.vel.y));
      };
    };
    track(a, dA); track(b, dB);
    room.run(4);
    return { room, a, b, dA, dB, hitAt, worstUp, worstVy };
  }

  test('a rear-end hit moves both cars, each on its own client, and momentum is roughly conserved', async () => {
    const { a, b, dA, dB, hitAt, worstUp, worstVy } = await rearEnd(false);
    expect(hitAt).toBeGreaterThan(0);
    const ia = Math.hypot(dA.x, dA.z), ib = Math.hypot(dB.x, dB.z), sum = Math.hypot(dA.x + dB.x, dA.z + dB.z);
    report(`rear-end, both sides detect: contact ticks Alice ${a.mp.stats.contactTicks}, Bob ${b.mp.stats.contactTicks}; events sent ${a.mp.stats.contactsSent}/${b.mp.stats.contactsSent}, applied ${a.mp.stats.eventsApplied}/${b.mp.stats.eventsApplied}, ignored ${a.mp.stats.eventsIgnored}/${b.mp.stats.eventsIgnored}; momentum change Alice ${ia.toFixed(0)} N s, Bob ${ib.toFixed(0)} N s, sum ${sum.toFixed(0)} N s`);
    for (const c of [a, b]) expect(c.mp.stats.contactTicks).toBeGreaterThan(0);   // both simulations saw it
    expect(a.mp.stats.eventsApplied + b.mp.stats.eventsApplied).toBe(0);         // so no event was applied: no double
    expect(a.mp.stats.eventsIgnored + b.mp.stats.eventsIgnored).toBeGreaterThan(0);
    expect(b.s.car.speedF).toBeGreaterThan(5);                                   // Bob was shoved on
    expect(ib).toBeGreaterThan(2000);
    expect(sum).toBeLessThan(0.35 * Math.max(ia, ib));                           // equal and opposite, roughly
    expect(worstUp).toBeGreaterThan(0.97); expect(worstVy).toBeLessThan(1);
    expect(b.s.car.proj.s - a.s.car.proj.s).toBeGreaterThan(4);                  // not through each other
  });

  test('a hit one side missed is applied there from the event, once', async () => {
    const { a, b, dA, dB, worstUp } = await rearEnd(true);
    const ia = Math.hypot(dA.x, dA.z), ib = Math.hypot(dB.x, dB.z), sum = Math.hypot(dA.x + dB.x, dA.z + dB.z);
    report(`rear-end, Bob's simulation blind: events sent by Alice ${a.mp.stats.contactsSent}, applied by Bob ${b.mp.stats.eventsApplied}, ignored ${b.mp.stats.eventsIgnored}; momentum change Alice ${ia.toFixed(0)} N s, Bob ${ib.toFixed(0)} N s, sum ${sum.toFixed(0)} N s`);
    expect(b.mp.stats.contactTicks).toBe(0);
    expect(a.mp.stats.contactsSent).toBeGreaterThan(0);
    expect(b.mp.stats.eventsApplied).toBe(a.mp.stats.contactsSent);   // every event once
    expect(b.mp.stats.eventsIgnored).toBe(0);
    expect(b.mp.stats.contactsSent).toBe(0);
    expect(b.s.car.speedF).toBeGreaterThan(5);
    expect(sum).toBeLessThan(0.35 * Math.max(ia, ib));
    expect(worstUp).toBeGreaterThan(0.97);
  });

  test('restarting onto an occupied spot launches nobody: not collidable until clear', async () => {
    const room = new Room();
    const a = await room.join('Alice', 'lcgt3'), b = await room.join('Bob', 'lcf1');
    room.settle();
    // both start on the same spot at once (as the game starts them), and later restart onto it together
    let contacts = 0, worstUp = 1, worstVy = 0;
    const watch = () => {
      for (const c of [a, b]) {
        contacts += c.s.contacts.length;
        worstUp = Math.min(worstUp, c.s.car.up.y); worstVy = Math.max(worstVy, Math.abs(c.s.car.vel.y));
      }
    };
    room.run(0.3, watch);
    expect(a.mp.noCollide && b.mp.noCollide).toBe(true);
    expect(dist(a.s.car.pos, b.s.car.pos)).toBeLessThan(5);    // on top of each other
    expect(flags(a, b).collidable).toBe(false);
    room.run(6, watch);
    expect(contacts).toBe(0);
    for (const c of [a, b]) expect(c.mp.noCollide).toBe(false);   // the F1 pulled away: both collidable again
    const epochs = [a.mp.epoch, b.mp.epoch];
    a.s.restart(); b.s.restart();
    room.run(0.5, watch);
    expect([a.mp.epoch, b.mp.epoch]).toEqual(epochs.map((e) => (e + 1) & 15));
    expect(a.mp.noCollide && b.mp.noCollide).toBe(true);
    expect(flags(a, b).sample.flags & STATE_FLAG.noCollide).toBeTruthy();
    room.run(2, watch);
    expect(contacts).toBe(0);
    expect(worstUp).toBeGreaterThan(0.97); expect(worstVy).toBeLessThan(1);
    for (const c of [a, b]) expect(c.s.car.speedF * 3.6).toBeGreaterThan(100);
  });

  test('identical cars that restart together and stay together: the lowest player id is collidable again, the rest wait', async () => {
    const room = new Room();
    const cs = [await room.join('Alice', 'lcgt3'), await room.join('Bob', 'lcgt3'), await room.join('Cy', 'lcgt3')];
    room.settle();
    let contacts = 0;
    room.run(CLEAR_SECS + 2, () => { for (const c of cs) contacts += c.s.contacts.length; });
    // the same car, driver and spot: they are still on top of each other
    for (const c of cs.slice(1)) expect(dist(cs[0].s.car.pos, c.s.car.pos)).toBeLessThan(0.5);
    const byId = [...cs].sort((p, q) => p.mp.net.selfId - q.mp.net.selfId);
    expect(byId.map((c) => c.mp.noCollide)).toEqual([false, true, true]);
    expect(contacts).toBe(0);
    // and nobody collides with anybody while they overlap
    for (const c of cs) expect(c.s.proxies.length).toBe(0);
  });

  test('a paused player is sent as paused and not collidable, and is a ghost again for a while after', async () => {
    const room = new Room();
    const a = await room.join('Alice', 'lcgt3'), b = await room.join('Bob', 'lcf1');
    room.settle();
    room.run(5);
    // Alice (the GT3, behind) opens the menu; Bob's F1 only gets further away
    expect(a.mp.noCollide).toBe(false);
    a.ticking = false;
    room.run(0.5);
    const p = flags(b, a);
    expect(p.sample.flags & STATE_FLAG.paused).toBeTruthy();
    expect(p.collidable).toBe(false);
    expect(p.sample.alpha).toBe(1);                               // still sending: not stale
    const held = { ...p.body };
    room.run(0.5);
    expect(dist(p.body, held)).toBeLessThan(0.01);                // held still, not extrapolated down the road
    a.ticking = true;
    room.run(0.2);
    expect(a.mp.noCollide).toBe(true);
    room.run(CLEAR_SECS + 0.3);
    expect(a.mp.noCollide).toBe(false);
  });

  test('joins, car changes and leaves: proxies come and go, and laps reach the board', async () => {
    const room = new Room();
    const a = await room.join('Alice', 'lcgt3', { flying: false, driver: coast });
    room.settle();
    const b = await room.join('Bob', 'drift', { flying: false, driver: full });
    room.settle();
    expect(a.mp.takeNotices().map((n) => n.text)).toContain('Bob joined');
    const pb = flags(a, b);
    expect(pb.spec?.id).toBe('drift');
    // Bob drives a short lap: put on the track just before each timing line in turn, 2 s apart
    const tr = b.s.track, lines = b.s.timing.lines;
    for (const k of [0, 1, 2, 0]) {
      b.s.car.placeAt(lines[k].s - 8 + (k === 0 && lines[k].s < 8 ? tr.L : 0), 0, 25);
      room.run(2);
    }
    room.run(0.5);
    const lap = b.s.timing.lastLap!;
    expect(lap.valid).toBe(true);
    expect(b.mp.stats.lapsSent).toBe(1);
    const row = a.mp.net.board.find((e) => e.name === 'Bob')!;
    expect(row.best).toBeCloseTo(lap.time, 5);
    expect(a.mp.takeNotices().map((n) => n.text)).toContain(`Bob: fastest lap ${fmtTime(row.best)}`);
    // Bob switches car: Alice's proxy of him takes the new body
    b.s.setCar(CARS.lcf1);
    room.run(0.5);
    expect(pb.spec?.id).toBe('lcf1');
    expect(pb.body.shape.mass).toBeCloseTo(b.s.car.shape.mass, 3);
    // Bob leaves: gone from Alice's players and her session's proxies
    b.mp.close();
    room.run(0.5);
    expect(a.mp.players.size).toBe(0);
    expect(a.s.proxies.length).toBe(0);
    expect(a.mp.takeNotices().map((n) => n.text)).toContain('Bob left');
  });
});
