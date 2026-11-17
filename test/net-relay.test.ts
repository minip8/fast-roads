import { describe, expect, it } from 'vitest';
import { NetClient, type NetEvent } from '../src/net/client';
import { type LinkConditions, type LoopbackEnd, LoopbackNet, type LoopbackPair } from '../src/net/loopback';
import {
  type CarState, decodeMessage, emptyCarState, encodeMessage, encodeState, ERROR, MSG, type NetMessage, PROTOCOL_VERSION, STATE_BYTES,
} from '../src/net/protocol';
import { emptySample } from '../src/net/remote';
import { Relay, type RelayOptions, sanitiseName } from '../server/relay';

// The relay (server/relay.ts) and NetClient (src/net/client.ts) end to end, in-process over the emulated network:
// joining, roster, car states, contacts, laps and the board, leaving, timeouts, abuse, a full room.

const LINK: LinkConditions = { latency: 0.04, jitter: 0.015, loss: 0.03, duplicate: 0.01 };

class World {
  net = new LoopbackNet(42);
  relay: Relay;
  clients: { c: NetClient; pair: LoopbackPair; events: NetEvent[]; car: (t: number) => CarState }[] = [];
  t = 0;
  private lastUpdate = 0; private lastFlush = 0;
  constructor(opt: Partial<RelayOptions> = {}) {
    this.relay = new Relay({ minLapSecs: 5, ...opt, now: () => this.net.now });
  }
  join(name: string, car = 'lcf1', room = 'TEST', circuit = 'monza', link = LINK, k = this.clients.length) {
    const pair = this.net.pair(link, link);
    this.relay.accept(pair.server);
    const c = new NetClient(pair.client, { room, name, car, circuit, clock: () => this.net.now });
    const entry = { c, pair, events: [] as NetEvent[], car: (t: number) => circling(t, k) };
    this.clients.push(entry);
    return entry;
  }
  // a raw connection, for sending what NetClient never would
  raw(link = LINK) {
    const pair = this.net.pair(link, link);
    this.relay.accept(pair.server);
    const got: NetMessage[] = [];
    let closed = '';
    pair.client.onMessage = (d) => { const m = decodeMessage(d); if (m.ok) got.push(m.msg); };
    pair.client.onClose = (r) => { closed = r; };
    return { end: pair.client as LoopbackEnd, pair, got, closed: () => closed };
  }
  run(seconds: number) {
    const end = this.t + seconds;
    while (this.t < end - 1e-9) {
      this.t += 1 / 120;
      this.net.advance(this.t);
      if (this.t - this.lastUpdate >= 1) { this.relay.update(); this.lastUpdate = this.t; }
      const b = this.relay.opt.batchInterval;
      if (b > 0 && this.t - this.lastFlush >= b - 1e-9) { this.relay.flush(); this.lastFlush = this.t; }
      for (const e of this.clients) {
        e.c.update(this.t);
        e.c.sendState(e.car(this.t), this.t);
        e.events.push(...e.c.takeEvents());
      }
    }
  }
}

// player k drives a 300 m circle at 60 m/s, a quarter lap apart
function circling(t: number, k: number): CarState {
  const R = 300, w = 60 / R, a = w * t + (k * Math.PI) / 2;
  return { ...emptyCarState(), x: R * Math.cos(a), y: 0.3, z: R * Math.sin(a), qx: 0, qy: Math.sin((-a) / 2), qz: 0, qw: Math.cos((-a) / 2),
    vx: -R * w * Math.sin(a), vz: R * w * Math.cos(a), wy: w, gear: 5, rpm: 9000, throttle: 0.7 };
}
const types = (ev: NetEvent[]) => ev.map((e) => e.type);

describe('relay and clients over the emulated network', () => {
  it('joins three players into one room, relays their cars and keeps every roster in step', () => {
    const w = new World();
    const a = w.join('Alice', 'lcf1', 'TEST', 'monza');
    w.run(0.5);
    const b = w.join('Bob', 'lcgt3', 'test', 'spa');   // lower case: the same room; its circuit stays monza
    const c = w.join('  Carla\u0000‮  ', 'drift');
    w.run(3);
    for (const e of [a, b, c]) {
      expect(e.c.status).toBe('joined');
      expect(e.c.circuit).toBe('monza');
      expect(e.c.room).toBe('TEST');
      expect([...e.c.players.values()].map((p) => p.name).sort()).toEqual(['Alice', 'Bob', 'Carla']);
      expect(e.c.remotes.size).toBe(2);
      expect(e.c.rtt).toBeGreaterThan(0.08);
      expect(e.c.rtt).toBeLessThan(0.12);
      expect(Math.abs(e.c.serverTime(w.t) - w.net.now)).toBeLessThan(0.01);
    }
    expect(types(a.events).filter((t) => t === 'join')).toEqual(['join', 'join']);
    expect(a.c.selfId).not.toBe(b.c.selfId);
    // every client sees every other car where it is now, to within a few centimetres at 60 m/s on a curve
    const out = emptySample();
    for (const viewer of [a, b, c]) {
      for (const [k, target] of [a, b, c].entries()) {
        if (target === viewer) continue;
        const s = viewer.c.sample(target.c.selfId, w.t, out)!;
        const truth = circling(w.t, k);
        // (mostly the two clocks' errors: 5 ms is 0.3 m at 60 m/s)
        expect(Math.hypot(s.x - truth.x, s.z - truth.z)).toBeLessThan(0.6);
        expect(s.collidable).toBe(true);
        expect(s.gear).toBe(5);
      }
    }
    expect(a.c.stats.unknownSender).toBe(0);
    expect(a.c.stats.malformed).toBe(0);
    expect(a.c.sendHz).toBe(40);
    expect(w.relay.stats.statesRelayed).toBeGreaterThan(600);
  });

  it('never trusts a claimed player id: the relay stamps the sender', () => {
    const w = new World();
    const a = w.join('Alice');
    const b = w.join('Bob');
    w.run(1);
    // Bob's client claims to be Alice in its state and contact
    const st = encodeState(circling(w.t, 3), 60000, w.t); st[1] = a.c.selfId;
    b.pair.client.send('unreliable', st);
    const contact = encodeMessage({ type: 'contact', from: a.c.selfId, to: a.c.selfId, timeWire: 0, ix: 1, iy: 0, iz: 0, px: 0, py: 0, pz: 0, closing: 3 });
    b.pair.client.send('reliable', contact);
    w.run(0.5);
    // the state was taken as Bob's (Alice has no proxy for herself, so a trusted id would count as an unknown
    // sender), and the contact "from Alice" reached her from Bob
    const contacts = a.events.filter((e) => e.type === 'contact');
    expect(contacts.length).toBe(1);
    expect(contacts[0]).toMatchObject({ from: b.c.selfId });
    expect(a.c.stats.unknownSender).toBe(0);
  });

  it('relays a contact to the other car only, with the impulse turned round', () => {
    const w = new World();
    const [a, b, c] = [w.join('A'), w.join('B'), w.join('C')];
    w.run(1);
    a.c.sendContact({ other: b.c.selfId, at: w.t, impulse: { x: 1200, y: 0, z: -300 }, point: { x: 10, y: 0.4, z: 20 }, closing: 7.5 });
    w.run(0.3);
    const hit = b.events.find((e) => e.type === 'contact');
    expect(hit).toBeDefined();
    if (hit?.type !== 'contact') return;
    expect(hit.from).toBe(a.c.selfId);
    expect(hit.impulse).toEqual({ x: -1200, y: -0, z: 300 });
    expect(hit.point.x).toBeCloseTo(10, 4);
    expect(hit.closing).toBe(7.5);
    expect(Math.abs(hit.time - (w.t - 0.3))).toBeLessThan(0.02);
    expect(c.events.some((e) => e.type === 'contact')).toBe(false);
    expect(a.events.some((e) => e.type === 'contact')).toBe(false);
    // a contact with nobody is refused
    a.c.sendContact({ other: 99, at: w.t, impulse: { x: 1, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 }, closing: 1 });
    w.run(0.3);
    expect(a.events.find((e) => e.type === 'error')).toMatchObject({ code: ERROR.badContact, fatal: false });
  });

  it('keeps the lap board from plausible laps and refuses the rest', () => {
    const w = new World();
    const [a, b] = [w.join('Alice'), w.join('Bob', 'lcgt3')];
    w.run(12);
    a.c.sendLap({ time: 10.5, sectors: [3, 3.5, 4], valid: true });
    b.c.sendLap({ time: 11.25, sectors: [3, 4, 4.25], valid: true });
    w.run(0.5);
    expect(b.c.board.map((e) => [e.name, e.car, e.best, e.laps])).toEqual([['Alice', 'lcf1', 10.5, 1], ['Bob', 'lcgt3', 11.25, 1]]);
    expect(a.events.filter((e) => e.type === 'lap').length).toBe(2);
    // a second lap too soon after the first, sectors that do not add up, one shorter than the minimum: refused
    a.c.sendLap({ time: 9, sectors: [3, 3, 3], valid: true });
    w.run(0.5);
    b.c.sendLap({ time: 9, sectors: [3, 3, 2], valid: true });
    w.run(0.5);
    const late = w.join('Late');
    w.run(1);
    late.c.sendLap({ time: 20, sectors: [5, 5, 10], valid: true });   // longer than it has been in the room
    late.c.sendLap({ time: 2, sectors: [1, 0.5, 0.5], valid: true });
    w.run(0.5);
    for (const e of [a, b]) expect(e.events.filter((x) => x.type === 'error').map((x) => x.type === 'error' && x.code)).toEqual([ERROR.lapRejected]);
    expect(late.events.filter((x) => x.type === 'error').length).toBe(2);
    expect(b.c.board.length).toBe(2);
    // a quicker valid lap later replaces the best; an invalid one is relayed but not on the board
    w.run(9);
    a.c.sendLap({ time: 10.25, sectors: [3, 3.25, 4], valid: true });
    w.run(11);
    b.c.sendLap({ time: 10.1, sectors: [3, 3, null], valid: false });
    w.run(0.5);
    expect(late.c.board.map((e) => [e.name, e.best, e.laps])).toEqual([['Alice', 10.25, 2], ['Bob', 11.25, 1]]);
    expect(late.events.filter((e) => e.type === 'lap').at(-1)).toMatchObject({ player: b.c.selfId, valid: false, time: 10.1 });
    // the board outlives a player leaving (by name) and is in the welcome of a later joiner
    a.c.close();
    w.run(0.5);
    const later = w.join('Later');
    w.run(0.5);
    expect(later.c.board[0]).toMatchObject({ name: 'Alice', player: 0, best: 10.25 });
  });

  it('passes on car changes, restarts and leaving, and times out a dead link', () => {
    const w = new World();
    const [a, b, c] = [w.join('Alice'), w.join('Bob'), w.join('Carla')];
    w.run(1);
    b.c.setPlayer({ car: 'drift', name: 'Bobby' });
    b.c.sendRestart();
    w.run(0.3);
    for (const e of [a, b, c]) expect(e.c.players.get(b.c.selfId)).toEqual({ id: b.c.selfId, name: 'Bobby', car: 'drift' });
    expect(a.events.find((e) => e.type === 'player')).toMatchObject({ before: { name: 'Bob', car: 'lcf1' } });
    expect(a.events.find((e) => e.type === 'restart')).toMatchObject({ player: b.c.selfId });
    expect(b.events.some((e) => e.type === 'restart')).toBe(false);
    b.c.setPlayer({ car: 'bogus' });
    w.run(0.3);
    expect(b.events.find((e) => e.type === 'error')).toMatchObject({ code: ERROR.badCar, fatal: false });

    c.c.close();
    w.run(0.3);
    expect(a.events.find((e) => e.type === 'leave')).toMatchObject({ reason: 'left', player: { name: 'Carla' } });
    expect(a.c.players.size).toBe(2);
    expect(a.c.remotes.has(c.c.selfId)).toBe(false);

    // Bob's link dies silently: the relay drops him after 10 s, his client gives up after 15 s
    b.pair.down = true;
    w.run(2);
    const out = emptySample();
    expect(a.c.sample(b.c.selfId, w.t, out)!.collidable).toBe(false);   // stale
    w.run(9.5);
    expect(a.events.filter((e) => e.type === 'leave').at(-1)).toMatchObject({ reason: 'timeout', player: { name: 'Bobby' } });
    expect(b.c.status).toBe('joined');
    w.run(5);
    expect(b.c.status).toBe('closed');
    expect(b.c.closeReason).toBe('timeout');
    expect(w.relay.connectionCount).toBe(1);
    // the room goes once it has been empty a minute
    a.c.close();
    w.run(30);
    expect(w.relay.rooms.size).toBe(1);
    w.run(31);
    expect(w.relay.rooms.size).toBe(0);
  });

  it('turns away a full room, another protocol version, a bad hello and a silent connection', () => {
    const w = new World({ maxPlayers: 2 });
    w.join('A'); w.join('B'); w.join('C');
    w.run(1);
    const turned = w.clients.filter((e) => e.c.status === 'closed');   // whichever hello came in last
    expect(turned.length).toBe(1);
    expect(turned[0].events.find((e) => e.type === 'error')).toMatchObject({ code: ERROR.roomFull, fatal: true });
    w.join('D', 'lcf1', 'OTHER');   // another room is fine
    w.run(1);
    expect(w.clients[3].c.status).toBe('joined');

    const old = w.raw();
    w.run(0.1);
    old.end.send('reliable', new Uint8Array([MSG.hello, PROTOCOL_VERSION + 1, 0, 1, 2, 3]));
    w.run(0.3);
    expect(old.got).toEqual([expect.objectContaining({ type: 'error', code: ERROR.version, fatal: true })]);
    expect(old.closed()).not.toBe('');

    for (const [why, bytes, code] of [
      ['garbage', new Uint8Array([0xde, 0xad, 0xbe, 0xef]), ERROR.malformed],
      ['state before hello', encodeState(emptyCarState(), 1, 0), ERROR.notJoined],
      ['unknown car', encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, mode: 'either', token: 0, room: 'R', name: 'x', car: 'tank', circuit: '' }), ERROR.badCar],
      ['unknown circuit', encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, mode: 'either', token: 0, room: 'R', name: 'x', car: 'lcf1', circuit: 'nurburg' }), ERROR.badCircuit],
      ['empty name', encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, mode: 'either', token: 0, room: 'R', name: ' ​\u0007 ', car: 'lcf1', circuit: '' }), ERROR.badName],
      ['too big', new Uint8Array(300).fill(MSG.hello), ERROR.tooBig],
    ] as [string, Uint8Array, number][]) {
      const r = w.raw();
      w.run(0.1);
      r.end.send('reliable', bytes);
      w.run(0.3);
      expect(r.got, why).toEqual([expect.objectContaining({ type: 'error', code, fatal: true })]);
      expect(r.closed(), why).not.toBe('');
    }

    const silent = w.raw();
    w.run(6);
    expect(silent.got).toEqual([expect.objectContaining({ type: 'error', code: ERROR.idle, fatal: true })]);
    expect(w.relay.connectionCount).toBe(3);
  });

  it('shrugs off garbage from a joined client, then kicks a persistent offender and an oversized message', () => {
    const w = new World();
    const a = w.join('A');
    const b = w.join('B');
    w.run(1);
    b.pair.client.send('reliable', new Uint8Array([MSG.board, 99]));   // does not decode
    b.pair.client.send('reliable', encodeMessage({ type: 'pong', nonce: 1, clientTime: 0, serverTime: 0 }));   // not a client message
    const bad = encodeState(emptyCarState(), 1, w.t); bad[38] = 99;
    b.pair.client.send('unreliable', bad);
    w.run(0.5);
    expect(b.c.status).toBe('joined');
    expect(b.events.filter((e) => e.type === 'error').every((e) => e.type === 'error' && !e.fatal)).toBe(true);
    expect(a.c.stats.malformed).toBe(0);   // nothing bad was passed on
    for (let i = 0; i < 60; i++) b.pair.client.send('reliable', new Uint8Array([0x7f, i]));
    w.run(5);
    expect(b.c.status).toBe('closed');
    expect(a.events.find((e) => e.type === 'leave')).toMatchObject({ reason: 'kicked' });

    const c = w.join('C');
    w.run(1);
    c.pair.client.send('reliable', new Uint8Array(1000));
    w.run(0.5);
    expect(c.events.find((e) => e.type === 'error')).toMatchObject({ code: ERROR.tooBig, fatal: true });
    expect(c.c.status).toBe('closed');
  });

  it('drops a flood of car states, and kicks a client that keeps flooding', () => {
    const w = new World();
    const a = w.join('A');
    const b = w.join('B');
    w.run(1);
    const before = a.c.stats.statesReceived;
    for (let k = 0; k < 120; k++) {   // B sends 1000 states a second for 0.12 s
      for (let i = 0; i < 8; i++) b.pair.client.send('unreliable', encodeState(circling(w.t, 1), 1000 + k * 8 + i, w.t));
      w.run(1 / 120);
      if (k === 60) expect(b.c.status).toBe('joined');
    }
    const relayed = a.c.stats.statesReceived - before;
    expect(relayed).toBeLessThan(30 + 1 * 60 + 40 + 10);   // burst + rate + B's own client's states, with loss
    w.run(3);
    expect(b.c.status).toBe('closed');
  });

  // Bandwidth per player: payload as measured, and on the wire estimated with WebSocket framing (2 bytes a frame
  // from the relay, 6 masked from a client) and 40 bytes of TCP/IPv4 headers a frame (each its own segment: the
  // worst case; TCP may coalesce some).
  function bandwidth(batchInterval: number) {
    const w = new World({ maxPlayers: 8, batchInterval });
    const all = Array.from({ length: 8 }, (_, k) => w.join(`P${k}`));
    w.run(2);
    const snap = () => all.map((e) => ({ ub: e.pair.client.sent.bytes, um: e.pair.client.sent.messages, db: e.pair.server.sent.bytes, dm: e.pair.server.sent.messages }));
    const s0 = snap(), secs = 10;
    w.run(secs);
    const s1 = snap(), avg = (f: (k: number) => number) => all.reduce((a, _, k) => a + f(k), 0) / all.length / secs;
    const r = {
      up: avg((k) => s1[k].ub - s0[k].ub), upMsgs: avg((k) => s1[k].um - s0[k].um),
      down: avg((k) => s1[k].db - s0[k].db), downMsgs: avg((k) => s1[k].dm - s0[k].dm), error: 0,
    };
    const out = emptySample();
    for (const [k, e] of all.entries()) {
      const s = all[(k + 1) % 8].c.sample(e.c.selfId, w.t, out)!, truth = circling(w.t, k);
      r.error = Math.max(r.error, Math.hypot(s.x - truth.x, s.z - truth.z));
      expect(all[(k + 1) % 8].c.remotes.size).toBe(7);
    }
    const wireUp = r.up + r.upMsgs * (6 + 40), wireDown = r.down + r.downMsgs * (2 + 40);
    if (process.env.NET_REPORT) {
      console.log(`8 players at 40 Hz, batch ${(batchInterval * 1000).toFixed(1)} ms: payload up ${r.up.toFixed(0)} B/s (${r.upMsgs.toFixed(0)} msgs/s), ` +
        `down ${r.down.toFixed(0)} B/s (${r.downMsgs.toFixed(0)} msgs/s); wire up ~${wireUp.toFixed(0)} B/s, down ~${wireDown.toFixed(0)} B/s; ` +
        `relay out ~${(8 * wireDown / 1024).toFixed(0)} KB/s; worst proxy error ${r.error.toFixed(2)} m`);
    }
    return r;
  }

  it('costs about 1.8 KB/s up and 11.8 KB/s down of payload per player in a full room of 8 at 40 Hz', () => {
    const r = bandwidth(0);
    // 43-byte states: up 40/s plus pings; down 7 x 40/s (less 3% loss on the emulated link) plus pongs
    expect(r.up).toBeGreaterThan(40 * STATE_BYTES);
    expect(r.up).toBeLessThan(40 * STATE_BYTES + 100);
    expect(r.down).toBeGreaterThan(7 * 40 * STATE_BYTES * 0.95);
    expect(r.down).toBeLessThan(7 * 40 * STATE_BYTES + 100);
    expect(r.downMsgs).toBeGreaterThan(260);
    // batching at 60 Hz: the same states in a quarter of the frames, the proxies as accurate
    const b = bandwidth(1 / 60);
    expect(b.downMsgs).toBeLessThan(65);
    expect(b.down).toBeLessThan(r.down + 2 * 65);
    expect(b.error).toBeLessThan(0.6);
  });

  it('sanitises names', () => {
    expect(sanitiseName('  Max\t\tVerstappen  ')).toBe('Max Verstappen');
    expect(sanitiseName('a\u0000b\u001bc‮d​e')).toBe('abcde');   // controls, a bidi override, a zero-width space
    expect(sanitiseName('Zoë')).toBe('Zoë');
    expect(sanitiseName('é́́́x')).toBe('é́́x');   // NFC, then at most two marks in a row
    expect([...sanitiseName('x'.repeat(40))].length).toBe(16);
    expect(sanitiseName('\u{1F3CE}\u{FE0F} racer')).toBe('\u{1F3CE}\u{FE0F} racer');   // emoji (and its variation selector) stay
  });
});
