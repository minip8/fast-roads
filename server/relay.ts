import { DEFAULT_CIRCUIT, NET_CARS, NET_CIRCUITS } from '../src/net/ids';
import {
  type BoardEntry, decodeMessage, encodeBundle, encodeMessage, ERROR, helloVersion, LEAVE_REASON, MAX_BOARD, MAX_BUNDLE, MAX_CLIENT_MSG,
  MAX_NAME_BYTES, MSG, NAME_CHARS, type NetMessage, type PlayerInfo, PROTOCOL_VERSION, STATE_BYTES, stateValid,
  truncUtf8, unwrapTime,
} from '../src/net/protocol';
import type { Transport } from '../src/net/transport';

// ============================================================================
// The relay: rooms of players, a shared clock, the session's lap board. It runs no physics: each client simulates
// its own car and the relay passes the car states on (the client's own bytes, with the player byte set to the
// sender's id: a client's claimed id is never used). Transport-agnostic: hand it each new connection (accept) and
// call update() now and then (timeouts); tests run it in-process over loopback.ts, server/ws.ts over WebSocket.
// docs/net.md lists the limits.
// ============================================================================
export interface RelayOptions {
  now: () => number;              // s, monotonic: the room clock every client syncs to
  maxPlayers: number;             // per room (ids 1-255)
  maxRooms: number;
  maxConnections: number;
  stateHz: number;                // car states a second a client may send (told in the welcome)
  stateBurst: number;             // ... and how many above that rate it may send in a burst
  reliableRate: number;           // other messages a second
  reliableBurst: number;
  maxViolations: number;          // bad or excess messages (decaying at 2 a second) before a client is kicked
  helloTimeout: number;           // s to send hello after connecting
  idleTimeout: number;            // s with nothing from a joined client (clients ping every 2 s)
  roomLinger: number;             // s an empty room (and its lap board) is kept for players to come back
  // 0: relay each car state as it comes. More: queue them per recipient and send what is queued as one bundle
  // (MSG.states) when flush() runs, which the caller does every batchInterval s (server/ws.ts does). Fewer, larger
  // frames (per-packet TCP/IP overhead is more than a state's 42 bytes) for up to batchInterval of added delay.
  batchInterval: number;
  cars: readonly string[];
  circuits: readonly string[];
  defaultCircuit: string;         // for a hello that does not name one
  minLapSecs: number | Record<string, number>;   // a lap quicker than this is refused (per circuit, or for all)
  // Decides whether a lap claim stands. The default (plausibleLap) checks it against the clock only. A later
  // verifier can replay the lap's inputs headlessly (the claim would then carry them: a new protocol version).
  verifyLap: (claim: LapClaim, opt: RelayOptions) => LapVerdict;
  log: (line: string) => void;
}

export interface LapClaim {
  player: number; name: string; car: string; circuit: string;
  time: number; sectors: (number | null)[]; valid: boolean;
  now: number;                    // relay time the claim arrived
  joinedAt: number;               // relay time the player joined
  lastLapAt: number | null;       // relay time of the player's previous accepted lap
  lastStateAt: number | null;     // relay time of the player's last car state
}
export type LapVerdict = { ok: true } | { ok: false; reason: string };

export const RELAY_DEFAULTS: Omit<RelayOptions, 'now'> = {
  maxPlayers: 8, maxRooms: 256, maxConnections: 2048,
  stateHz: 60, stateBurst: 30, reliableRate: 20, reliableBurst: 40, maxViolations: 50,
  helloTimeout: 5, idleTimeout: 10, roomLinger: 60, batchInterval: 0,
  cars: NET_CARS, circuits: NET_CIRCUITS, defaultCircuit: DEFAULT_CIRCUIT,
  minLapSecs: 40,
  verifyLap: plausibleLap,
  log: () => {},
};

// The lap could have been driven: long enough, sectors adding up, not more laps than time allows, and the car was
// on track (sending states) when it finished.
export function plausibleLap(c: LapClaim, opt: RelayOptions): LapVerdict {
  const min = typeof opt.minLapSecs === 'number' ? opt.minLapSecs : opt.minLapSecs[c.circuit] ?? 0;
  if (!(c.time >= min && c.time <= 3600)) return { ok: false, reason: `lap time ${c.time.toFixed(3)} s out of range` };
  if (c.valid) {
    if (c.sectors.length !== 3 || c.sectors.some((s) => s == null || !(s > 0))) return { ok: false, reason: 'a valid lap needs three sectors' };
    const sum = (c.sectors as number[]).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - c.time) > 0.002) return { ok: false, reason: 'sectors do not add up to the lap' };
  }
  const slack = 1;
  if (c.now - c.joinedAt < c.time - slack) return { ok: false, reason: 'lap longer than the time in the room' };
  if (c.lastLapAt != null && c.now - c.lastLapAt < c.time - slack) return { ok: false, reason: 'lap longer than the time since the last one' };
  if (c.lastStateAt == null || c.now - c.lastStateAt > 2) return { ok: false, reason: 'no car on track' };
  return { ok: true };
}

// A player name made safe to show: Unicode-normalised, control, format and private-use characters removed,
// whitespace collapsed, at most two combining marks in a row, NAME_CHARS characters and MAX_NAME_BYTES bytes.
// Empty if nothing is left.
export function sanitiseName(raw: string): string {
  let s = raw.normalize('NFC').replace(/\s+/gu, ' ');
  s = s.replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu, '');
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');
  s = [...s.trim()].slice(0, NAME_CHARS).join('').trim();
  return truncUtf8(s, MAX_NAME_BYTES);
}

interface Bucket { tokens: number; at: number }
interface Conn {
  t: Transport;
  id: number;                     // 0 until joined
  room: Room | null;
  name: string; car: string;
  connectedAt: number; joinedAt: number; lastHeard: number;
  lastStateAt: number | null; lastLapAt: number | null;
  states: Bucket; reliable: Bucket;
  violations: number; violationsAt: number; rateDrops: number;
  gone: boolean;
  pending: Uint8Array[];           // car states waiting for flush() (batching)
}
interface BoardRow extends BoardEntry { key: string }
export interface Room {
  code: string; circuit: string; createdAt: number;
  players: Map<number, Conn>;
  board: BoardRow[];
  nextId: number;
  emptySince: number | null;
}

export interface RelayStats {
  connections: number; messagesIn: number; bytesIn: number; messagesOut: number; bytesOut: number;
  statesRelayed: number; dropped: number; kicked: number;
}

export class Relay {
  readonly opt: RelayOptions;
  readonly rooms = new Map<string, Room>();
  readonly stats: RelayStats = { connections: 0, messagesIn: 0, bytesIn: 0, messagesOut: 0, bytesOut: 0, statesRelayed: 0, dropped: 0, kicked: 0 };
  private conns = new Set<Conn>();

  constructor(opt: Partial<RelayOptions> & { now: () => number }) {
    this.opt = { ...RELAY_DEFAULTS, ...opt };
  }

  get connectionCount() { return this.conns.size; }

  // A new connection (open, or about to be).
  accept(t: Transport) {
    const now = this.opt.now();
    const c: Conn = {
      t, id: 0, room: null, name: '', car: '', connectedAt: now, joinedAt: 0, lastHeard: now, lastStateAt: null, lastLapAt: null,
      states: { tokens: this.opt.stateBurst, at: now }, reliable: { tokens: this.opt.reliableBurst, at: now },
      violations: 0, violationsAt: now, rateDrops: 0, gone: false, pending: [],
    };
    if (this.conns.size >= this.opt.maxConnections) { this.sendTo(c, encodeMessage({ type: 'error', code: ERROR.serverFull, fatal: true, message: 'server full' })); t.close('server full'); return; }
    this.conns.add(c);
    this.stats.connections++;
    t.onMessage = (data) => this.receive(c, data);
    t.onClose = () => this.drop(c, LEAVE_REASON.left);
  }

  // Timeouts and empty rooms. Call every second or so.
  update() {
    const now = this.opt.now(), o = this.opt;
    for (const c of this.conns) {
      if (!c.id && now - c.connectedAt > o.helloTimeout) this.kick(c, ERROR.idle, 'no hello', LEAVE_REASON.timeout);
      else if (c.id && now - c.lastHeard > o.idleTimeout) this.kick(c, ERROR.idle, 'timed out', LEAVE_REASON.timeout);
    }
    for (const [code, r] of this.rooms) if (r.emptySince != null && now - r.emptySince >= o.roomLinger) this.rooms.delete(code);
  }

  // Sends the queued car states (batching: RelayOptions.batchInterval), one frame per recipient.
  flush() {
    for (const c of this.conns) {
      if (!c.pending.length) continue;
      this.sendTo(c, c.pending.length === 1 ? c.pending[0] : encodeBundle(c.pending), 'unreliable');
      c.pending = [];
    }
  }

  // Tells everyone and closes every connection.
  shutdown(message = 'server shutting down') {
    for (const c of [...this.conns]) this.kick(c, ERROR.shutdown, message, LEAVE_REASON.left);
  }

  // ------------------------------------------------------------------------
  private receive(c: Conn, data: Uint8Array) {
    if (c.gone) return;
    const now = this.opt.now();
    this.stats.messagesIn++; this.stats.bytesIn += data.length;
    c.lastHeard = now;
    if (data.length > MAX_CLIENT_MSG) return this.kick(c, ERROR.tooBig, `message over ${MAX_CLIENT_MSG} bytes`, LEAVE_REASON.kicked);
    if (!c.id) return this.hello(c, data, now);
    const room = c.room!;
    if (data[0] === MSG.state) {   // the hot path: check, stamp, forward
      if (!take(c.states, now, this.opt.stateHz, this.opt.stateBurst)) {   // dropped; every 10th counts against the client
        this.stats.dropped++;
        if (++c.rateDrops % 10 === 0) this.violation(c, now, ERROR.rate, 'too many states');
        return;
      }
      if (!stateValid(data)) return this.violation(c, now, ERROR.malformed, 'bad state');
      const wire = new DataView(data.buffer, data.byteOffset, STATE_BYTES).getUint32(4, true);
      const t = unwrapTime(wire, now);
      if (t < now - 5 || t > now + 2) { this.stats.dropped++; return; }   // a client clock far off: not worth relaying
      c.lastStateAt = now;
      const out = data.slice(); out[1] = c.id;
      for (const p of room.players.values()) if (p !== c) { this.relayState(p, out); this.stats.statesRelayed++; }
      return;
    }
    if (!take(c.reliable, now, this.opt.reliableRate, this.opt.reliableBurst)) { this.stats.dropped++; return this.violation(c, now, ERROR.rate, 'too many messages'); }
    const d = decodeMessage(data);
    if (!d.ok) return this.violation(c, now, ERROR.malformed, d.error);
    this.handle(c, room, d.msg, data, now);
  }

  private hello(c: Conn, data: Uint8Array, now: number) {
    const v = helloVersion(data);
    if (v !== null && v !== PROTOCOL_VERSION) return this.kick(c, ERROR.version, `protocol ${PROTOCOL_VERSION} only (client speaks ${v})`, LEAVE_REASON.kicked);
    const d = decodeMessage(data);
    if (!d.ok) return this.kick(c, ERROR.malformed, d.error, LEAVE_REASON.kicked);
    const m = d.msg;
    if (m.type !== 'hello') return this.kick(c, ERROR.notJoined, 'hello first', LEAVE_REASON.kicked);
    const o = this.opt;
    const name = sanitiseName(m.name);
    if (!name) return this.kick(c, ERROR.badName, 'empty name', LEAVE_REASON.kicked);
    if (!o.cars.includes(m.car)) return this.kick(c, ERROR.badCar, `unknown car ${m.car}`, LEAVE_REASON.kicked);
    let room = this.rooms.get(m.room);
    if (!room) {
      const circuit = m.circuit || o.defaultCircuit;
      if (!o.circuits.includes(circuit)) return this.kick(c, ERROR.badCircuit, `unknown circuit ${circuit}`, LEAVE_REASON.kicked);
      if (this.rooms.size >= o.maxRooms) return this.kick(c, ERROR.serverFull, 'too many rooms', LEAVE_REASON.kicked);
      room = { code: m.room, circuit, createdAt: now, players: new Map(), board: [], nextId: 1, emptySince: null };
      this.rooms.set(m.room, room);
      o.log(`room ${room.code} opened (${circuit})`);
    }
    if (room.players.size >= o.maxPlayers) return this.kick(c, ERROR.roomFull, `room ${room.code} is full`, LEAVE_REASON.kicked);
    let id = room.nextId;
    while (room.players.has(id)) id = (id % 255) + 1;   // ids are not reused soon: late packets of a leaver stay theirs
    room.nextId = (id % 255) + 1;
    c.id = id; c.room = room; c.car = m.car; c.name = uniqueName(room, name, null); c.joinedAt = now;
    room.players.set(id, c); room.emptySince = null;
    const me: PlayerInfo = { id, name: c.name, car: c.car };
    this.sendTo(c, encodeMessage({
      type: 'welcome', version: PROTOCOL_VERSION, you: id, room: room.code, circuit: room.circuit, serverTime: now,
      maxPlayers: o.maxPlayers, stateHz: o.stateHz, players: [...room.players.values()].map(info), board: room.board,
    }));
    this.broadcast(room, encodeMessage({ type: 'joined', player: me }), c);
    o.log(`room ${room.code}: ${id} ${JSON.stringify(c.name)} joined (${c.car}), ${room.players.size} in`);
  }

  private handle(c: Conn, room: Room, m: NetMessage, data: Uint8Array, now: number) {
    switch (m.type) {
      case 'ping': return this.sendTo(c, encodeMessage({ type: 'pong', nonce: m.nonce, clientTime: m.clientTime, serverTime: now }));
      case 'player': {
        const name = sanitiseName(m.player.name);
        if (!name) return this.sendTo(c, encodeMessage({ type: 'error', code: ERROR.badName, fatal: false, message: 'empty name' }));
        if (!this.opt.cars.includes(m.player.car)) return this.sendTo(c, encodeMessage({ type: 'error', code: ERROR.badCar, fatal: false, message: `unknown car ${m.player.car}` }));
        c.name = uniqueName(room, name, c); c.car = m.player.car;
        return this.broadcast(room, encodeMessage({ type: 'player', player: info(c) }));
      }
      case 'contact': {
        const other = room.players.get(m.to);
        if (!other || other === c) return this.sendTo(c, encodeMessage({ type: 'error', code: ERROR.badContact, fatal: false, message: 'no such car' }));
        const out = data.slice(); out[1] = c.id;
        return this.sendTo(other, out);
      }
      case 'lap': return this.lap(c, room, m, data, now);
      case 'restart': {
        const out = data.slice(); out[1] = c.id;
        return this.broadcast(room, out, c);
      }
      case 'hello': return this.kick(c, ERROR.notJoined, 'already joined', LEAVE_REASON.kicked);
      default: return this.violation(c, now, ERROR.malformed, `${m.type} is not a client message`);
    }
  }

  private lap(c: Conn, room: Room, m: Extract<NetMessage, { type: 'lap' }>, data: Uint8Array, now: number) {
    const verdict = this.opt.verifyLap({
      player: c.id, name: c.name, car: c.car, circuit: room.circuit, time: m.time, sectors: m.sectors, valid: m.valid,
      now, joinedAt: c.joinedAt, lastLapAt: c.lastLapAt, lastStateAt: c.lastStateAt,
    }, this.opt);
    if (!verdict.ok) {
      this.opt.log(`room ${room.code}: lap by ${c.id} refused: ${verdict.reason}`);
      return this.sendTo(c, encodeMessage({ type: 'error', code: ERROR.lapRejected, fatal: false, message: verdict.reason }));
    }
    c.lastLapAt = now;
    const out = data.slice(); out[1] = c.id;
    this.broadcast(room, out);
    if (!m.valid) return;
    const key = `${c.id}:${c.car}`;
    let row = room.board.find((r) => r.key === key && r.player === c.id);
    if (!row) { row = { key, player: c.id, name: c.name, car: c.car, best: m.time, sectors: m.sectors, laps: 0 }; room.board.push(row); }
    row.laps++; row.name = c.name;
    if (m.time < row.best) { row.best = m.time; row.sectors = m.sectors; }
    room.board.sort((a, b) => a.best - b.best);
    if (room.board.length > MAX_BOARD) room.board.length = MAX_BOARD;
    this.broadcast(room, encodeMessage({ type: 'board', board: room.board }));
  }

  private relayState(p: Conn, state: Uint8Array) {
    if (!this.opt.batchInterval) return this.sendTo(p, state, 'unreliable');
    const k = p.pending.findIndex((q) => q[1] === state[1]);   // a newer state from the same car replaces the queued one
    if (k >= 0) p.pending[k] = state; else p.pending.push(state);
    if (p.pending.length >= MAX_BUNDLE) { this.sendTo(p, encodeBundle(p.pending), 'unreliable'); p.pending = []; }
  }

  private violation(c: Conn, now: number, code: number, message: string) {
    c.violations = Math.max(0, c.violations - 2 * (now - c.violationsAt)) + 1;
    c.violationsAt = now;
    if (c.violations > this.opt.maxViolations) return this.kick(c, code, `${message} (too often)`, LEAVE_REASON.kicked);
    if (c.violations === 1 || code !== ERROR.rate) this.sendTo(c, encodeMessage({ type: 'error', code, fatal: false, message }));
  }

  private kick(c: Conn, code: number, message: string, reason: number) {
    if (c.gone) return;
    this.sendTo(c, encodeMessage({ type: 'error', code, fatal: true, message }));
    this.stats.kicked++;
    this.opt.log(`kick ${c.room ? `${c.room.code}:${c.id}` : 'unjoined'}: ${message}`);
    this.drop(c, reason);
    c.t.close(message);
  }

  private drop(c: Conn, reason: number) {
    if (c.gone) return;
    c.gone = true;
    this.conns.delete(c);
    c.pending = [];
    const room = c.room;
    if (!room) return;
    room.players.delete(c.id);
    for (const r of room.board) if (r.player === c.id) r.player = 0;
    this.broadcast(room, encodeMessage({ type: 'left', id: c.id, reason }));
    if (!room.players.size) room.emptySince = this.opt.now();
    this.opt.log(`room ${room.code}: ${c.id} left, ${room.players.size} in`);
  }

  private broadcast(room: Room, data: Uint8Array, except?: Conn) {
    for (const p of room.players.values()) if (p !== except) this.sendTo(p, data);
  }
  private sendTo(c: Conn, data: Uint8Array, lane: 'reliable' | 'unreliable' = 'reliable') {
    this.stats.messagesOut++; this.stats.bytesOut += data.length;
    c.t.send(lane, data);
  }
}

const info = (c: Conn): PlayerInfo => ({ id: c.id, name: c.name, car: c.car });

// Two players of one name in a room are told apart: "Max", "Max 2".
function uniqueName(room: Room, name: string, self: Conn | null): string {
  const taken = (n: string) => [...room.players.values()].some((p) => p !== self && p.name === n);
  if (!taken(name)) return name;
  for (let k = 2; ; k++) {
    const suffix = ` ${k}`;
    const base = truncUtf8([...name].slice(0, NAME_CHARS - suffix.length).join(''), MAX_NAME_BYTES - suffix.length);
    if (!taken(base + suffix)) return base + suffix;
  }
}

function take(b: Bucket, now: number, rate: number, burst: number): boolean {
  b.tokens = Math.min(burst, b.tokens + (now - b.at) * rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
