import * as THREE from 'three';
import { CARS, type CarId, type CarInfo } from './cars';
import { collide, contactBody, newBody, type ContactBody, type ContactShape } from './collide';
import { DT } from './config';
import { CAR_REASON, emptyCarState, emptySample, STATE_FLAG, type BoardEntry, type NetClient, type NetEvent, type PlayerInfo, type RemoteSample } from './net';
import { createVehicle, type Session } from './sim';
import type { Lap } from './timing';
import type { TrackDef } from './tracks';
import { fmtTime } from './util';
import type { DriveInput } from './vehicle';
import { COMPOUND_CODE, Weekend } from './weekend';

// ============================================================================
// Multiplayer glue: one game Session joined to a room through a NetClient (docs/net.md). No DOM, no rendering, so the
// tests run exactly this code with Sessions in Node; main.ts adds the drawing (remoteCars.ts) and the HUD (netHud.ts).
//
// - Our car: after every physics tick its state goes to the room (NetClient.sendState sends at its own rate), with the
//   restart epoch bumped whenever the Session puts it at the start spot (Session.resets), and each completed lap
//   from the timing (Timing.lastLap) goes to the board. A car switch is told to the room.
// - Other cars: each player's RemoteCar is sampled at every tick's time into a ContactBody, which is in
//   Session.proxies (so our car is pushed off it) only while it is collidable.
// - Not collidable (STATE_FLAG.noCollide on our car, honoured for every proxy): our car from joining, after every
//   restart and while the game is paused (no ticks: `idle` sends the paused state), until its box, grown by
//   CLEAR_MARGIN, has overlapped no other car for CLEAR_SECS (not counting cars that are not collidable themselves
//   and have a higher player id: see checkClear). A proxy that its owner marks so, that is paused, or that
//   has gone stale (RemoteCar's collidable). While ours is not collidable it collides with nothing.
// - Contacts: each client resolves its own car against the proxies and applies its own half at once. It also sends a
//   `contact` event to the other car's client for every CHUNK_SECS of contact with it (the impulse summed over the
//   chunk). The receiver applies its half from an event only if its own simulation had no contact with that car from
//   W before the event's time to the moment it arrived (W = contactWindow(): a round trip plus jitter and margin);
//   having applied one, it does not collide with that car's proxy until W after the event's time, so its own late
//   detection of the same hit cannot add a second half. Events from a car while ours is not collidable, or older
//   than MAX_EVENT_AGE, are dropped. The impulse is applied as a velocity and yaw-rate change (no push: the
//   overlap is long gone), its lever arm taken from where our car was at the hit, capped (MAX_DV, MAX_DYAW).
// ============================================================================
export const CLEAR_SECS = 1;          // s clear of every other car before a car that was not collidable is again
export const CLEAR_MARGIN = 0.5;      // m added round the box for that test
export const CHUNK_SECS = 0.1;        // s of contact summed into one contact event
export const MAX_EVENT_AGE = 1;       // s: a contact event later than this is dropped
const MAX_DV = 20, MAX_DYAW = 3;      // m/s, rad/s: caps on what one event can do to our car
const HISTORY = 128;                  // ticks of our own pose kept (lever arms for late events)
const HIT_KEEP = 3;                   // s of local contact times kept per player

// The contact window W (s) for a link of this round trip and jitter.
export const contactWindow = (rtt: number, jitter: number) => Math.min(0.5, Math.max(0.12, 0.08 + rtt + 2 * jitter));

// Another player, as this client sees them.
export interface RemotePlayer {
  readonly id: number;
  info: PlayerInfo;
  spec: CarInfo | null;               // their car (null: an id this build does not know; never collided with)
  readonly body: ContactBody;         // the proxy at the last tick's time
  readonly sample: RemoteSample;      // ...and the sample it came from
  hasSample: boolean;                 // anything received yet
  collidable: boolean;                // in Session.proxies at the last tick
  suppressUntil: number;              // relay time: not collided with until then (a hit applied from its event)
  readonly hits: number[];            // relay times of the ticks our simulation had contact with this car
  chunk: Chunk | null;                // contact being summed for the next event
}
interface Chunk { at: number; ix: number; iz: number; px: number; py: number; pz: number; closing: number }

export interface MultiplayerStats {
  contactTicks: number;               // ticks with a contact against a proxy (our half applied by the Session)
  contactsSent: number;               // contact events sent
  eventsApplied: number;              // contact events applied (our simulation had missed the hit)
  eventsIgnored: number;              // ...ignored because our simulation had it
  eventsDropped: number;              // ...dropped (unknown player, too late, our car not collidable)
  lapsSent: number;
}

// Something to tell the player: plain text for the HUD's feed, or a 'flag' (lights out, the final lap, a penalty...)
// for the big message in the middle of the screen, with a line under it.
export interface Notice { kind: 'join' | 'leave' | 'best' | 'car' | 'error' | 'race' | 'flag'; text: string; sub?: string }

export class Multiplayer {
  readonly players = new Map<number, RemotePlayer>();   // everyone else in the room
  readonly stats: MultiplayerStats = { contactTicks: 0, contactsSent: 0, eventsApplied: 0, eventsIgnored: 0, eventsDropped: 0, lapsSent: 0 };
  noCollide = true;                   // our car is not collidable (see above)
  epoch = 0;                          // restart epoch sent with our state
  // Testing: false keeps every proxy out of the Session, so this client's simulation misses every hit and its half
  // can only come from the other client's events.
  localCollisions = true;
  // The race weekend as our car lives it (weekend.ts): sessions, grid, pit lane, recoveries, running order.
  readonly weekend: Weekend;
  private clearFor = 0;
  private paused = false;
  private lastResets: number;
  private lastLap: Lap | null;
  private carId: string;
  private readonly joinedSim: number;
  private readonly state = emptyCarState();
  private readonly self = newBody({ front: 0, rear: 0, halfWidth: 0, mass: 0, yawInertia: 0 });
  private readonly other = newBody(this.self.shape);
  private readonly bodyOwner = new Map<ContactBody, RemotePlayer>();
  private readonly hist = Array.from({ length: HISTORY }, () => ({ t: -Infinity, x: 0, z: 0, fx: 0, fz: 1 }));
  private histN = 0;
  private notices: Notice[] = [];
  private bests = new Map<string, number>();   // player:car -> best valid lap seen

  constructor(readonly net: NetClient, readonly session: Session, def: TrackDef) {
    this.weekend = new Weekend(net, session, def, (kind, text, sub) => this.notices.push({ kind, text, sub }));
    this.lastResets = session.resets;
    this.lastLap = session.timing.lastLap;
    this.carId = session.car.spec.id;
    this.joinedSim = session.simTime;
    for (const p of net.players.values()) if (p.id !== net.selfId) this.addPlayer(p);
    this.seedBests(net.board);
    if (net.status === 'joined' && net.players.get(net.selfId)?.car !== this.carId) net.setPlayer({ car: this.carId });
  }

  get window() { return contactWindow(this.net.rtt, this.net.jitter); }
  get connected() { return this.net.status === 'joined'; }

  // Every frame (or tick, in tests), before the ticks: what arrived. paused: the game is not running its simulation
  // (menu, before the first Drive). Returns the network's events for the game's own handling (circuit, errors).
  update(now: number, paused = false): NetEvent[] {
    this.net.update(now);
    if (paused && !this.paused) this.setGhost();
    this.paused = paused;
    const events = this.net.takeEvents();
    for (const e of events) { this.handle(e, now); this.weekend.onEvent(e); }
    if (this.connected) this.weekend.update(now);
    return events;
  }

  // One physics tick at local time tickAt (the time the tick's result is for): the proxies placed for it, the Session
  // ticked, then our side of it sent. parked: the player is in the menu while the race goes on (Weekend.keepsRunning):
  // the car brakes to a stop where it is, a ghost.
  tick(inp: DriveInput, autopilot: boolean, tickAt: number, parked = false) {
    this.beforeTick(tickAt);
    this.session.tick(this.weekend.input(inp, tickAt, parked), autopilot && !parked);
    this.afterTick(tickAt);
  }

  // The player's restart key (R / Enter, the menu's Restart): what the weekend allows (Weekend.requestRestart).
  requestRestart() { this.weekend.requestRestart(); }

  // A frame without ticks (paused): our car's state as held, marked paused.
  idle(now: number) {
    this.sync();
    if (!this.paused) { this.paused = true; this.setGhost(); }
    this.fillState(true);
    this.net.sendState(this.state, now);
  }

  // Player id's car at local time `now`, for drawing (null: nothing received yet).
  sampleAt(id: number, now: number, out: RemoteSample): RemoteSample | null { return this.net.sample(id, now, out); }

  takeNotices(): Notice[] { const n = this.notices; this.notices = []; return n; }

  close(reason = 'left') {
    this.net.close(reason);
    this.dropAll();
    this.weekend.dispose();
  }

  // ------------------------------------------------------------------------
  private beforeTick(tickAt: number) {
    this.sync();
    const T = this.net.serverTime(tickAt), proxies = this.session.proxies, seen = this.weekend.mpSamples;
    proxies.length = 0;
    seen.clear();
    for (const p of this.players.values()) {
      const s = this.net.remotes.get(p.id)?.sample(T, p.sample, true) ?? null;
      p.hasSample = s != null;
      p.collidable = false;
      if (!s || !p.spec) continue;
      bodyFrom(s, p.body);
      if (s.alpha > 0) seen.set(p.id, { x: s.x, z: s.z, compound: s.compound, reason: s.reason });
      p.collidable = s.collidable && !(s.flags & STATE_FLAG.paused) && T >= p.suppressUntil;
      if (p.collidable && !this.noCollide && this.localCollisions) proxies.push(p.body);
    }
  }

  private afterTick(tickAt: number) {
    const moved = this.sync();   // the tick may have put the car back (stuck, upside down)
    const car = this.session.car, T = this.net.serverTime(tickAt);
    // our half was applied by the Session: sum it per car for the events
    for (const c of moved ? [] : this.session.contacts) {
      if (c.a !== car) continue;
      const p = this.bodyOwner.get(c.b as ContactBody);
      if (!p) continue;
      this.stats.contactTicks++;
      p.hits.push(T);
      const m = car.shape.mass, k = c.contact;
      if (p.chunk && tickAt - p.chunk.at >= CHUNK_SECS - 1e-6) this.flush(p);
      const ch = p.chunk ??= { at: tickAt, ix: 0, iz: 0, px: k.x, py: car.pos.y, pz: k.z, closing: 0 };
      ch.ix += k.a.dvx * m; ch.iz += k.a.dvz * m;
      if (k.speed >= ch.closing) { ch.closing = k.speed; ch.px = k.x; ch.py = car.pos.y; ch.pz = k.z; }
    }
    for (const p of this.players.values()) {
      if (p.chunk && p.hits[p.hits.length - 1] !== T) this.flush(p);   // the contact ended
      while (p.hits.length && p.hits[0] < T - HIT_KEEP) p.hits.shift();
    }
    this.weekend.afterTick(tickAt);
    // a ghost for the weekend's reasons (the pit lane, spectating, parked, finished, recovering, one-shot), and until
    // clear of every car after it
    if (this.weekend.reason !== CAR_REASON.none) this.setGhost();
    else if (this.noCollide) this.checkClear();
    // our pose, for late events' lever arms
    const h = this.hist[this.histN++ % HISTORY];
    h.t = T; h.x = car.pos.x; h.z = car.pos.z; h.fx = car.fwd.x; h.fz = car.fwd.z;
    this.sendLaps(tickAt);
    this.fillState(false);
    this.net.sendState(this.state, tickAt);
  }

  // Restarts and car switches since we last looked; returns whether the car was put back.
  private sync(): boolean {
    const s = this.session;
    let moved = false;
    if (s.resets !== this.lastResets) {
      moved = true;
      this.lastResets = s.resets;
      this.epoch = (this.epoch + 1) & 15;
      this.net.sendRestart();
      this.setGhost();
    }
    if (s.car.spec.id !== this.carId) {
      this.carId = s.car.spec.id;
      this.lastLap = s.timing.lastLap;
      this.net.setPlayer({ car: this.carId });
    }
    return moved;
  }

  private setGhost() {
    this.noCollide = true; this.clearFor = 0;
    for (const p of this.players.values()) { if (p.chunk) this.flush(p); }
  }

  // Our car (grown by CLEAR_MARGIN) against every other car heard from lately. A car that is itself not collidable
  // counts only if its player id is below ours: of cars that restarted onto the same spot together and stay together
  // (each would otherwise wait for the other for ever), the lowest id is collidable again first and the rest wait for
  // it, so every client reaches the same order and nobody turns collidable inside a collidable car.
  private checkClear() {
    if (this.paused) { this.clearFor = 0; return; }
    const me = contactBody(this.session.car, this.self);
    me.shape = grown(me.shape);
    let clear = true;
    for (const p of this.players.values()) {
      if (!p.hasSample || !p.spec || p.sample.age > this.net.remotes.get(p.id)!.opt.collideAge) continue;
      if (p.sample.flags & STATE_FLAG.noCollide && p.id > this.net.selfId) continue;
      copyBody(p.body, this.other);
      this.other.shape = grown(p.body.shape);
      if (collide(me, this.other)) { clear = false; break; }
    }
    this.clearFor = clear ? this.clearFor + DT : 0;
    if (this.clearFor >= CLEAR_SECS - 1e-9) this.noCollide = false;
  }

  private flush(p: RemotePlayer) {
    const c = p.chunk;
    p.chunk = null;
    if (!c) return;
    this.net.sendContact({ other: p.id, at: c.at, impulse: { x: c.ix, y: 0, z: c.iz }, point: { x: c.px, y: c.py, z: c.pz }, closing: c.closing });
    this.stats.contactsSent++;
  }

  private sendLaps(tickAt: number) {
    const tm = this.session.timing, lap = tm.lastLap;
    if (lap === this.lastLap) return;
    this.lastLap = lap;
    // a lap started before we joined is refused by the relay (longer than our time in the room): not sent
    if (!lap || this.session.simTime - lap.time < this.joinedSim - 0.5) return;
    // the crossing that ended it, in local time: the lap just ended, so the timing's lap start is that crossing
    const at = tickAt - (this.session.simTime - (tm.lapStart ?? this.session.simTime));
    if (!this.weekend.shouldSend(lap, this.net.serverTime(at))) return;
    this.net.sendLap({ time: lap.time, sectors: lap.sectors, valid: lap.valid, at });
    this.stats.lapsSent++;
  }

  private fillState(paused: boolean) {
    const c = this.session.car, s = this.state;
    s.x = c.pos.x; s.y = c.pos.y; s.z = c.pos.z;
    s.qx = c.quat.x; s.qy = c.quat.y; s.qz = c.quat.z; s.qw = c.quat.w;
    // held still while paused: no velocity, or every client would extrapolate it on down the road
    const k = paused ? 0 : 1;
    s.vx = c.vel.x * k; s.vy = c.vel.y * k; s.vz = c.vel.z * k;
    s.wx = c.angv.x * k; s.wy = c.angv.y * k; s.wz = c.angv.z * k;
    s.steer = c.steer; s.throttle = paused ? 0 : c.throttle; s.brake = paused ? 0 : c.brake; s.gear = c.gear; s.rpm = c.rpm;
    s.flags = (this.noCollide || paused ? STATE_FLAG.noCollide : 0) | (paused ? STATE_FLAG.paused : 0) | (c.flapsOpen ? STATE_FLAG.flapsOpen : 0);
    s.epoch = this.epoch;
    s.compound = COMPOUND_CODE[c.compound.id];
    s.reason = paused ? CAR_REASON.paused : this.weekend.reason !== CAR_REASON.none ? this.weekend.reason : this.noCollide ? CAR_REASON.ghost : CAR_REASON.none;
  }

  private handle(e: NetEvent, now: number) {
    switch (e.type) {
      case 'welcome':
        for (const p of e.players) if (p.id !== e.you) this.addPlayer(p);
        return;
      case 'board': this.seedBests(e.board); return;
      case 'join':
        this.addPlayer(e.player);
        this.notices.push({ kind: 'join', text: `${e.player.name} joined` });
        return;
      case 'leave':
        this.removePlayer(e.player.id);
        this.notices.push({ kind: 'leave', text: `${e.player.name} ${e.reason === 'left' ? 'left' : e.reason === 'timeout' ? 'lost connection' : 'was removed'}` });
        return;
      case 'player': {
        const p = this.players.get(e.player.id);
        if (!p) return;
        p.info = e.player;
        if (e.player.car !== e.before.car) { this.setSpec(p); this.notices.push({ kind: 'car', text: `${e.player.name} is in the ${p.spec?.name ?? e.player.car}` }); }
        return;
      }
      case 'contact': return this.contactEvent(e, now);
      case 'lap': {
        if (!e.valid) return;
        const who = this.net.players.get(e.player), key = `${e.player}:${who?.car ?? ''}`, prev = this.bests.get(key);
        if (prev != null && prev <= e.time) return;
        this.bests.set(key, e.time);
        const fastest = [...this.bests.values()].every((t) => t >= e.time);
        const name = e.player === this.net.selfId ? 'You' : who?.name ?? 'Someone';
        this.notices.push({ kind: 'best', text: `${name}: ${fastest ? 'fastest lap' : 'best lap'} ${fmtTime(e.time)}` });
        return;
      }
      case 'error':
        this.notices.push({ kind: 'error', text: e.message });
        return;
      case 'closed': this.dropAll(); return;
      default: return;
    }
  }

  private contactEvent(e: Extract<NetEvent, { type: 'contact' }>, now: number) {
    const p = this.players.get(e.from), Tn = this.net.serverTime(now), W = this.window;
    if (!p || this.noCollide || this.paused || Tn - e.time > MAX_EVENT_AGE) { this.stats.eventsDropped++; return; }
    if (p.hits.some((h) => h >= e.time - W && h <= Tn + 1e-6)) { this.stats.eventsIgnored++; return; }
    const car = this.session.car, sh = car.shape;
    // the lever arm in the car's frame at the hit, turned to its heading now
    const then = this.poseAt(e.time), rx = e.point.x - then.x, rz = e.point.z - then.z;
    const along = rx * then.fx + rz * then.fz, across = rx * then.fz - rz * then.fx;
    const f = car.fwd, fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
    const wx = along * fx + across * fz, wz = along * fz - across * fx;
    let dvx = e.impulse.x / sh.mass, dvz = e.impulse.z / sh.mass;
    const dv = Math.hypot(dvx, dvz);
    if (dv > MAX_DV) { dvx *= MAX_DV / dv; dvz *= MAX_DV / dv; }
    const dyaw = Math.max(-MAX_DYAW, Math.min(MAX_DYAW, (wz * e.impulse.x - wx * e.impulse.z) / Math.max(100, sh.yawInertia)));
    car.applyContact({ dx: 0, dz: 0, dvx, dvz, dyaw });
    p.suppressUntil = Math.max(p.suppressUntil, e.time + W);
    this.stats.eventsApplied++;
  }

  private poseAt(t: number) {
    let best = this.hist[0];
    for (const h of this.hist) if (Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    if (best.t === -Infinity) { const c = this.session.car; return { t, x: c.pos.x, z: c.pos.z, fx: c.fwd.x, fz: c.fwd.z }; }
    return best;
  }

  private addPlayer(info: PlayerInfo) {
    if (info.id === this.net.selfId) return;
    const existing = this.players.get(info.id);
    if (existing) { existing.info = info; this.setSpec(existing); return; }
    const p: RemotePlayer = { id: info.id, info, spec: null, body: newBody(this.self.shape), sample: emptySample(), hasSample: false,
      collidable: false, suppressUntil: -Infinity, hits: [], chunk: null };
    this.setSpec(p);
    this.players.set(info.id, p);
    this.bodyOwner.set(p.body, p);
  }

  private setSpec(p: RemotePlayer) {
    p.spec = p.info.car in CARS ? CARS[p.info.car as CarId] : null;
    if (p.spec) p.body.shape = shapeOf(this.session, p.spec);
    p.chunk = null;
  }

  private removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.bodyOwner.delete(p.body);
    const k = this.session.proxies.indexOf(p.body);
    if (k >= 0) this.session.proxies.splice(k, 1);
  }

  private dropAll() {
    for (const id of [...this.players.keys()]) this.removePlayer(id);
    this.session.proxies.length = 0;
  }

  private seedBests(board: readonly BoardEntry[]) {
    for (const b of board) if (b.player && b.best != null) {
      const key = `${b.player}:${b.car}`, prev = this.bests.get(key);
      if (prev == null || b.best < prev) this.bests.set(key, b.best);
    }
  }
}

// A car's contact shape, from a car of that spec built once (both engines work it out from their own body).
const shapes = new Map<string, ContactShape>();
export function shapeOf(session: Session, spec: CarInfo): ContactShape {
  let s = shapes.get(spec.id);
  if (!s) {
    const v = createVehicle(session.world, session.track, new THREE.Scene(), CARS[spec.id as CarId]);
    s = v.shape;
    v.destroy();
    shapes.set(spec.id, s);
  }
  return s;
}

const grownShapes = new WeakMap<ContactShape, ContactShape>();
function grown(s: ContactShape): ContactShape {
  let g = grownShapes.get(s);
  if (!g) grownShapes.set(s, g = { ...s, front: s.front + CLEAR_MARGIN, rear: s.rear + CLEAR_MARGIN, halfWidth: s.halfWidth + CLEAR_MARGIN });
  return g;
}

// A remote sample as a contact body: position, heading (the body's +z in the ground plane), velocity, yaw rate.
export function bodyFrom(s: RemoteSample, out: ContactBody): ContactBody {
  const { qx, qy, qz, qw } = s;
  const fx = 2 * (qx * qz + qw * qy), fz = 1 - 2 * (qx * qx + qy * qy), len = Math.hypot(fx, fz);
  out.x = s.x; out.y = s.y; out.z = s.z;
  if (len > 1e-3) { out.fwdX = fx / len; out.fwdZ = fz / len; }
  out.vx = s.vx; out.vz = s.vz;
  out.yawRate = s.wy;
  return out;
}

function copyBody(a: ContactBody, out: ContactBody) {
  out.x = a.x; out.y = a.y; out.z = a.z; out.fwdX = a.fwdX; out.fwdZ = a.fwdZ; out.vx = a.vx; out.vz = a.vz; out.yawRate = a.yawRate;
}

