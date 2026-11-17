import { ClockSync } from './clock';
import {
  type BoardEntry, type CarState, encodeMessage, encodeState, decodeMessage, isId, isRoomCode, LEAVE_REASON,
  MAX_NAME_BYTES, NAME_CHARS, type NetMessage, type StateMsg, type PlayerInfo, PROTOCOL_VERSION, STATE_BYTES, timeToWire, truncUtf8, unwrapTime,
} from './protocol';
import { RemoteCar, type RemoteOptions, type RemoteSample } from './remote';
import type { Transport } from './transport';

// ============================================================================
// The game's side of a multiplayer session (docs/net.md has the API and an example game loop). Plain data in and
// out: the game hands it its own car as a CarState and reads the other cars back as RemoteSamples; it knows nothing
// of Vehicle, three.js or the DOM. It has no timers: the game calls update(now) every frame (or tick), and
// sendState(state, at) every tick or frame, which sends at most `sendHz` times a second.
// All times are seconds: `now` is the game's local monotonic clock (performance.now() / 1000), relay times come
// from serverTime(now).
// ============================================================================
export interface NetClientOptions {
  room: string;                 // room code, 1-8 of A-Z 0-9 (lower case is upper-cased)
  name: string;                 // trimmed to NAME_CHARS characters; the relay sanitises it further
  car: string;                  // car id (cars.ts)
  circuit?: string;             // circuit wanted if this hello creates the room ('' or absent: the relay's default)
  sendHz?: number;              // car states a second (default 40; the relay's welcome caps it)
  // Local clock for stamping arrivals as they happen (performance.now() / 1000 in the browser). Without one a
  // message counts as arriving at the next update(now), which adds up to an update interval to every round trip.
  clock?: () => number;
  timeout?: number;             // s with nothing heard from the relay before giving up (default 15)
  remote?: Partial<RemoteOptions>;   // proxy tuning (remote.ts)
}

export type LeaveReason = 'left' | 'timeout' | 'kicked';
export type NetEvent =
  | { type: 'welcome'; you: number; room: string; circuit: string; players: PlayerInfo[] }
  | { type: 'join'; player: PlayerInfo }
  | { type: 'leave'; player: PlayerInfo; reason: LeaveReason }
  | { type: 'player'; player: PlayerInfo; before: PlayerInfo }       // a name or car change (also our own, echoed)
  // Another car's client resolved a hit with us. impulse: what to apply to OUR car (N s, world; the opposite of
  // what the sender's car received) at `point`; time: relay time of the hit; closing speed (m/s).
  | { type: 'contact'; from: number; time: number; impulse: Vec3; point: Vec3; closing: number }
  | { type: 'lap'; player: number; time: number; sectors: (number | null)[]; valid: boolean }   // accepted laps only
  | { type: 'board'; board: BoardEntry[] }
  | { type: 'restart'; player: number }
  | { type: 'error'; code: number; fatal: boolean; message: string }
  | { type: 'closed'; reason: string };
export interface Vec3 { x: number; y: number; z: number }

export type ClientStatus = 'connecting' | 'joining' | 'joined' | 'closed';

export interface ClientStats {
  sentMessages: number; sentBytes: number; statesSent: number;
  receivedMessages: number; receivedBytes: number; statesReceived: number;
  malformed: number;            // messages from the relay that did not decode
  unknownSender: number;        // states for no player in the roster (or ourselves)
}

const LEAVE_NAMES: Record<number, LeaveReason> = { [LEAVE_REASON.left]: 'left', [LEAVE_REASON.timeout]: 'timeout', [LEAVE_REASON.kicked]: 'kicked' };
const PING_FAST = 0.5, PING_SLOW = 2, FAST_PINGS = 6;

export class NetClient {
  status: ClientStatus = 'connecting';
  closeReason = '';
  selfId = 0;
  room: string;
  circuit = '';                  // the room's circuit (from the welcome: may differ from the one asked for)
  maxPlayers = 0;
  sendHz: number;
  readonly players = new Map<number, PlayerInfo>();   // everyone in the room, ourselves included
  readonly remotes = new Map<number, RemoteCar>();    // everyone else's proxy
  board: BoardEntry[] = [];
  readonly clock = new ClockSync();
  readonly stats: ClientStats = { sentMessages: 0, sentBytes: 0, statesSent: 0, receivedMessages: 0, receivedBytes: 0, statesReceived: 0, malformed: 0, unknownSender: 0 };

  private events: NetEvent[] = [];
  private inbox: { data: Uint8Array | null; at: number | null; reason?: string }[] = [];   // data null: the transport closed
  private name: string; private car: string; private wantCircuit: string;
  private helloAt = -1;
  private seq = 0;
  private nextSend = -Infinity;
  private nonce = 0;
  private pings = new Map<number, number>();         // nonce -> local send time
  private nextPing = 0;
  private lastHeard = 0;
  private readonly stateBuf = new Uint8Array(STATE_BYTES);
  private readonly timeout: number;
  private readonly clockFn: (() => number) | null;
  private readonly remoteOpt: Partial<RemoteOptions>;

  constructor(readonly transport: Transport, opt: NetClientOptions) {
    this.room = opt.room.toUpperCase();
    if (!isRoomCode(this.room)) throw new Error(`room code must be 1-8 of A-Z 0-9: ${JSON.stringify(opt.room)}`);
    if (!isId(opt.car)) throw new Error(`bad car id ${JSON.stringify(opt.car)}`);
    if (opt.circuit && !isId(opt.circuit)) throw new Error(`bad circuit id ${JSON.stringify(opt.circuit)}`);
    this.name = clipName(opt.name);
    this.car = opt.car;
    this.wantCircuit = opt.circuit ?? '';
    this.sendHz = opt.sendHz ?? 40;
    this.timeout = opt.timeout ?? 15;
    this.clockFn = opt.clock ?? null;
    this.remoteOpt = opt.remote ?? {};
    transport.onMessage = (data) => this.inbox.push({ data, at: this.clockFn ? this.clockFn() : null });
    // (queued too, so messages that came before the close, such as the relay's reason for it, are seen first)
    transport.onClose = (reason) => this.inbox.push({ data: null, at: null, reason });
  }

  // Every frame: handles what arrived, says hello once the transport is open, pings the clock, notices a dead link.
  update(now: number) {
    const inbox = this.inbox; this.inbox = [];
    for (const m of inbox) {
      if (this.status === 'closed') break;
      if (m.data) this.receive(m.data, m.at ?? now); else this.closed(m.reason ?? 'closed');
    }
    if (this.status === 'closed') return;
    if (this.status === 'connecting' && this.transport.state === 'open') {
      this.status = 'joining';
      this.helloAt = now; this.lastHeard = now;
      this.send(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, room: this.room, name: this.name, car: this.car, circuit: this.wantCircuit }));
    }
    if (this.status === 'joined' && now >= this.nextPing) {
      this.nextPing = now + (this.clock.samples < FAST_PINGS ? PING_FAST : PING_SLOW);
      const nonce = this.nonce = (this.nonce + 1) >>> 0;
      this.pings.set(nonce, now);
      if (this.pings.size > 32) this.pings.delete(this.pings.keys().next().value!);
      this.send(encodeMessage({ type: 'ping', nonce, clientTime: now }));
    }
    if ((this.status === 'joining' || this.status === 'joined') && now - this.lastHeard > this.timeout) this.close('timeout');
  }

  // The relay clock at local time `now`.
  serverTime(now: number) { return this.clock.serverTime(now); }
  get rtt() { return this.clock.rtt; }
  get jitter() { return this.clock.jitter; }

  // Our car's state as of local time `at` (now, or the time the physics tick is for when sending from inside a
  // batch of ticks). Sent only once joined and when due (sendHz, by `at`); returns whether it went.
  sendState(state: CarState, at: number): boolean {
    if (this.status !== 'joined' || at + 1e-4 < this.nextSend) return false;
    const iv = 1 / this.sendHz;
    this.nextSend = Math.max(this.nextSend + iv, at + iv / 2);
    this.seq = (this.seq + 1) & 0xffff;
    encodeState(state, this.seq, this.serverTime(at), this.stateBuf);
    this.stats.statesSent++;
    this.send(this.stateBuf, 'unreliable');
    return true;
  }

  // The car of player `id` at local time `now` (the present, for drawing and colliding), or null (no such player
  // or nothing received yet). out: reused by the caller.
  sample(id: number, now: number, out: RemoteSample, smooth = true): RemoteSample | null {
    return this.remotes.get(id)?.sample(this.serverTime(now), out, smooth) ?? null;
  }

  // We were put back at the start spot (bump CarState.epoch as well, so proxies do not blend across the jump).
  sendRestart() { if (this.status === 'joined') this.send(encodeMessage({ type: 'restart', player: 0 })); }

  // A lap finished (all laps, valid or not: the relay keeps the board from the valid ones).
  sendLap(lap: { time: number; sectors: (number | null)[]; valid: boolean }) {
    if (this.status === 'joined') this.send(encodeMessage({ type: 'lap', player: 0, time: lap.time, sectors: lap.sectors.slice(0, 3), valid: lap.valid }));
  }

  // Our car hit player `other`'s proxy: impulse is what OUR car received (N s, world), at local time `at`.
  sendContact(c: { other: number; at: number; impulse: Vec3; point: Vec3; closing: number }) {
    if (this.status !== 'joined') return;
    const t = this.serverTime(c.at);
    this.send(encodeMessage({ type: 'contact', from: 0, to: c.other, timeWire: timeToWire(t),
      ix: c.impulse.x, iy: c.impulse.y, iz: c.impulse.z, px: c.point.x, py: c.point.y, pz: c.point.z,
      closing: Math.max(0, Math.min(200, c.closing)) }));
  }

  // A new car or name (the relay answers with a 'player' event for us when it takes it).
  setPlayer(p: { name?: string; car?: string }) {
    if (p.car !== undefined && !isId(p.car)) throw new Error(`bad car id ${JSON.stringify(p.car)}`);
    if (p.name !== undefined) this.name = clipName(p.name);
    if (p.car !== undefined) this.car = p.car;
    if (this.status === 'joined') this.send(encodeMessage({ type: 'player', player: { id: 0, name: this.name, car: this.car } }));
  }

  // What happened since the last call, in order.
  takeEvents(): NetEvent[] { const e = this.events; this.events = []; return e; }

  close(reason = 'left') {
    if (this.status === 'closed') return;
    this.transport.close(reason);
    this.closed(reason);
  }

  // ------------------------------------------------------------------------
  private send(data: Uint8Array, lane: 'reliable' | 'unreliable' = 'reliable') {
    this.stats.sentMessages++; this.stats.sentBytes += data.length;
    this.transport.send(lane, data);
  }

  private closed(reason: string) {
    if (this.status === 'closed') return;
    this.status = 'closed'; this.closeReason = reason;
    this.events.push({ type: 'closed', reason });
  }

  private receive(data: Uint8Array, at: number) {
    this.stats.receivedMessages++; this.stats.receivedBytes += data.length;
    const d = decodeMessage(data);
    if (!d.ok) { this.stats.malformed++; return; }
    this.lastHeard = Math.max(this.lastHeard, at);
    const m = d.msg;
    if (this.status === 'joining') {
      if (m.type === 'welcome') this.welcome(m, at);
      else if (m.type === 'error') this.events.push({ type: 'error', code: m.code, fatal: m.fatal, message: m.message });
      return;
    }
    if (this.status !== 'joined') return;
    this.handle(m, at);
  }

  private welcome(m: Extract<NetMessage, { type: 'welcome' }>, at: number) {
    this.status = 'joined';
    this.selfId = m.you; this.room = m.room; this.circuit = m.circuit; this.maxPlayers = m.maxPlayers;
    this.sendHz = Math.min(this.sendHz, m.stateHz);
    this.clock.seed(m.serverTime, this.helloAt, at);
    for (const p of m.players) this.addPlayer(p);
    this.board = m.board;
    this.nextPing = at;
    this.events.push({ type: 'welcome', you: m.you, room: m.room, circuit: m.circuit, players: m.players });
    this.events.push({ type: 'board', board: m.board });
  }

  private addPlayer(p: PlayerInfo) {
    this.players.set(p.id, p);
    if (p.id !== this.selfId && !this.remotes.has(p.id)) this.remotes.set(p.id, new RemoteCar(this.remoteOpt));
  }

  private carState(m: StateMsg, at: number) {
    const car = this.remotes.get(m.player);
    if (!car) { this.stats.unknownSender++; return; }
    this.stats.statesReceived++;
    const now = this.serverTime(at);
    car.push({ ...m, time: unwrapTime(m.timeWire, now) }, now);
  }

  private handle(m: NetMessage, at: number) {
    switch (m.type) {
      case 'state': return this.carState(m, at);
      case 'states': for (const s of m.states) this.carState(s, at); return;
      case 'pong': {
        const sent = this.pings.get(m.nonce);
        if (sent === undefined) return;
        this.pings.delete(m.nonce);
        this.clock.sample(m.serverTime, sent, at);
        return;
      }
      case 'joined':
        if (this.players.has(m.player.id)) return;
        this.addPlayer(m.player);
        this.events.push({ type: 'join', player: m.player });
        return;
      case 'left': {
        const p = this.players.get(m.id);
        if (!p || m.id === this.selfId) return;
        this.players.delete(m.id); this.remotes.delete(m.id);
        this.events.push({ type: 'leave', player: p, reason: LEAVE_NAMES[m.reason] ?? 'left' });
        return;
      }
      case 'player': {
        const before = this.players.get(m.player.id);
        if (!before) return;
        this.players.set(m.player.id, m.player);
        this.events.push({ type: 'player', player: m.player, before });
        return;
      }
      case 'contact':
        if (m.to !== this.selfId || !this.players.has(m.from)) return;
        this.events.push({ type: 'contact', from: m.from, time: unwrapTime(m.timeWire, this.serverTime(at)),
          impulse: { x: -m.ix, y: -m.iy, z: -m.iz }, point: { x: m.px, y: m.py, z: m.pz }, closing: m.closing });
        return;
      case 'lap': this.events.push({ type: 'lap', player: m.player, time: m.time, sectors: m.sectors, valid: m.valid }); return;
      case 'board': this.board = m.board; this.events.push({ type: 'board', board: m.board }); return;
      case 'restart':
        // (the proxy is not reset here: the state after the restart may already be in, and its epoch handles the jump)
        this.events.push({ type: 'restart', player: m.player });
        return;
      case 'error': this.events.push({ type: 'error', code: m.code, fatal: m.fatal, message: m.message }); return;
      default: return;   // client-bound only: anything else from the relay is ignored
    }
  }
}

function clipName(name: string): string {
  const chars = [...name.trim()].slice(0, NAME_CHARS).join('');
  return truncUtf8(chars, MAX_NAME_BYTES);
}
