// ============================================================================
// Multiplayer wire protocol (docs/net.md is the reference: keep the two in step). Pure byte handling, no I/O, no
// DOM, no Node: the browser client (client.ts) and the Node relay (server/) share it.
//
// Every message is one transport frame that starts with a u8 type. Little-endian throughout. Strings are a u8 byte
// count then that many UTF-8 bytes. Messages a client sends that the relay passes on (state, contact, lap,
// restart) keep a player byte at offset 1: the client writes 0 and the relay overwrites it with the sender's id, so
// it can forward the client's own bytes without re-encoding them and never trusts a claimed id.
//
// Decoding never throws: decodeMessage returns { ok: false, error } for anything malformed, truncated, with
// trailing bytes, out of range or of an unknown type, which the relay is exposed to from the internet.
//
// Versioning: PROTOCOL_VERSION is in hello and welcome, at the same place (u16 at offset 1) in every version, so a
// relay can refuse a client of another version (helloVersion) even when the rest of its hello no longer parses.
// Types 0x20-0x2f are reserved for race-session messages (grid, start lights, results).
// ============================================================================
export const PROTOCOL_VERSION = 1;

export const MSG = {
  state: 0x01,       // unreliable, both ways: a car's state (STATE_BYTES)
  states: 0x02,      // unreliable, relay -> client: several car states in one frame (batching)
  hello: 0x10,       // client -> relay: join a room
  welcome: 0x11,     // relay -> client: joined (you, room, circuit, clock, roster, lap board)
  joined: 0x12,      // relay -> clients: a player joined
  left: 0x13,        // relay -> clients: a player left
  player: 0x14,      // client -> relay: change my name/car; relay -> clients: a player's name/car now
  ping: 0x15,        // client -> relay: clock ping
  pong: 0x16,        // relay -> client: clock pong
  contact: 0x17,     // client -> relay -> the other car's client: a car-to-car hit
  lap: 0x18,         // client -> relay -> clients: a lap completed (relayed only if accepted)
  board: 0x19,       // relay -> clients: the session's lap board
  restart: 0x1a,     // client -> relay -> clients: the car was put back at the start spot
  error: 0x1f,       // relay -> client: an error; fatal ones are followed by the relay closing the connection
} as const;
export type MsgType = (typeof MSG)[keyof typeof MSG];

// ---------------------------------------------------------------------------- limits of the format
export const MAX_ROOM_BYTES = 8;         // room code: 1-8 of A-Z 0-9
export const MAX_NAME_BYTES = 48;        // player name, UTF-8 (the relay also caps it at NAME_CHARS characters)
export const NAME_CHARS = 16;
export const MAX_ID_BYTES = 16;          // car / circuit id: 1-16 of a-z 0-9
export const MAX_ERROR_BYTES = 200;
export const MAX_BOARD = 32;             // lap board entries
export const MAX_ROSTER = 32;            // players in a welcome
export const MAX_CLIENT_MSG = 256;       // the largest message a client may send (a hello is at most 95 bytes)
export const NO_TIME = 0xffffffff;       // a lap's sector that was not timed
const ROOM_RE = /^[A-Z0-9]{1,8}$/, ID_RE = /^[a-z0-9]{1,16}$/;

// ---------------------------------------------------------------------------- car state
// What a client says about its own car, 30-60 times a second. Units: m, m/s, rad/s, rad, world axes (y up);
// angular velocity in world axes; quaternion (x, y, z, w) the body's rotation.
export interface CarState {
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  wx: number; wy: number; wz: number;
  steer: number;                 // front wheel angle (rad), + = left
  throttle: number; brake: number;   // pedals as applied, 0..1
  gear: number;                  // -1 reverse, 0 neutral, 1..15
  rpm: number;                   // 0..30000
  flags: number;                 // STATE_FLAG bits
  epoch: number;                 // 0..15, +1 (mod 16) at every restart or teleport: receivers do not blend across it
}
export const STATE_FLAG = {
  noCollide: 1,                  // do not collide with this car (just restarted, in the pits, a ghost)
  paused: 2,                     // the driver is in the menu (the car is held still)
  flapsOpen: 4,                  // movable wings open (drawn by the proxy)
} as const;
const FLAGS_KNOWN = 7;

export function emptyCarState(): CarState {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0,
    steer: 0, throttle: 0, brake: 0, gear: 0, rpm: 0, flags: 0, epoch: 0 };
}

// A state on the wire: the car state plus who (set by the relay), sequence and time.
export interface StateMsg extends CarState {
  type: 'state';
  player: number;                // 0 from a client; the sender's id from the relay
  seq: number;                   // u16, +1 per state sent (wraps): newer = seqNewer(a, b)
  timeWire: number;              // u32: the sender's estimate of the relay clock, in TIME_UNITS_PER_S, mod 2^32
}

// Layout (STATE_BYTES = 42):
//   0 u8 type | 1 u8 player | 2 u16 seq | 4 u32 time (1e-4 s, relay clock, mod 2^32)
//   8 i24 x | 11 i24 y | 14 i24 z (mm, +-8388 m)
//   17 u16 q0 | 19 u16 q1 | 21 u16 q2: smallest-three quaternion: the three components other than the largest, each
//      15 bits over [-1/sqrt2, 1/sqrt2]; bit 15 of q0 and q1 hold the dropped component's index (0-3: x y z w)
//   23 i16 vx, vy, vz (0.01 m/s, +-327 m/s) | 29 i16 wx, wy, wz (0.001 rad/s, +-32.7 rad/s)
//   35 i8 steer (0.01 rad) | 36 u8 throttle | 37 u8 brake (/255) | 38 i8 gear | 39 u16 rpm | 41 u8 flags (bits 0-3)
//      and epoch (bits 4-7)
export const STATE_BYTES = 42;
export const TIME_UNITS_PER_S = 10000;
const POS_Q = 1000, VEL_Q = 100, ANG_Q = 1000, STEER_Q = 100, PEDAL_Q = 255;
const Q_MAX = 16383, Q_RANGE = Math.SQRT1_2;
const I24 = 0x7fffff;

// Into `out` (at least STATE_BYTES); returns STATE_BYTES. Values past a field's range are clamped; non-finite ones
// are written as 0 (the quaternion as identity), so a broken local state never makes an undecodable packet.
export function encodeState(s: CarState, seq: number, timeS: number, out: Uint8Array = new Uint8Array(STATE_BYTES)): Uint8Array {
  const v = view(out);
  v.setUint8(0, MSG.state); v.setUint8(1, 0);
  v.setUint16(2, seq & 0xffff, true);
  v.setUint32(4, timeToWire(timeS), true);
  setI24(v, 8, q(s.x, POS_Q, I24)); setI24(v, 11, q(s.y, POS_Q, I24)); setI24(v, 14, q(s.z, POS_Q, I24));
  packQuat(v, 17, s.qx, s.qy, s.qz, s.qw);
  v.setInt16(23, q(s.vx, VEL_Q, 32767), true); v.setInt16(25, q(s.vy, VEL_Q, 32767), true); v.setInt16(27, q(s.vz, VEL_Q, 32767), true);
  v.setInt16(29, q(s.wx, ANG_Q, 32767), true); v.setInt16(31, q(s.wy, ANG_Q, 32767), true); v.setInt16(33, q(s.wz, ANG_Q, 32767), true);
  v.setInt8(35, q(s.steer, STEER_Q, 127));
  v.setUint8(36, clamp(Math.round(fin(s.throttle) * PEDAL_Q), 0, 255)); v.setUint8(37, clamp(Math.round(fin(s.brake) * PEDAL_Q), 0, 255));
  v.setInt8(38, clamp(Math.round(fin(s.gear)), -1, 15));
  v.setUint16(39, clamp(Math.round(fin(s.rpm)), 0, 30000), true);
  v.setUint8(41, (s.flags & FLAGS_KNOWN) | ((s.epoch & 15) << 4));
  return out;
}

// The relay's check of a client's state before forwarding it: the decoder's checks, without building an object.
export function stateValid(d: Uint8Array): boolean {
  if (d.length !== STATE_BYTES || d[0] !== MSG.state) return false;
  const v = view(d);
  return quatValid(v, 17) && v.getInt8(38) >= -1 && v.getInt8(38) <= 15 && v.getUint16(39, true) <= 30000 && (d[41] & 8) === 0;
}

function decodeState(r: Reader): StateMsg {
  if (r.d.length !== STATE_BYTES) r.fail(r.d.length < STATE_BYTES ? 'truncated' : 'trailing bytes');
  r.at = STATE_BYTES;
  return stateAt(r, 0);
}

// The state whose first byte (its type) is at offset o of the reader's bytes (STATE_BYTES of them are there).
function stateAt(r: Reader, o: number): StateMsg {
  const v = r.v;
  if (v.getUint8(o) !== MSG.state) r.fail('not a state');
  if (!quatValid(v, o + 17)) r.fail('bad quaternion');
  const gear = v.getInt8(o + 38), rpm = v.getUint16(o + 39, true), f = v.getUint8(o + 41);
  if (gear < -1 || gear > 15 || rpm > 30000 || (f & 8)) r.fail('state out of range');
  const m: StateMsg = {
    type: 'state', player: v.getUint8(o + 1), seq: v.getUint16(o + 2, true), timeWire: v.getUint32(o + 4, true),
    x: getI24(v, o + 8) / POS_Q, y: getI24(v, o + 11) / POS_Q, z: getI24(v, o + 14) / POS_Q,
    qx: 0, qy: 0, qz: 0, qw: 1,
    vx: v.getInt16(o + 23, true) / VEL_Q, vy: v.getInt16(o + 25, true) / VEL_Q, vz: v.getInt16(o + 27, true) / VEL_Q,
    wx: v.getInt16(o + 29, true) / ANG_Q, wy: v.getInt16(o + 31, true) / ANG_Q, wz: v.getInt16(o + 33, true) / ANG_Q,
    steer: v.getInt8(o + 35) / STEER_Q, throttle: v.getUint8(o + 36) / PEDAL_Q, brake: v.getUint8(o + 37) / PEDAL_Q,
    gear, rpm, flags: f & FLAGS_KNOWN, epoch: f >> 4,
  };
  unpackQuat(v, o + 17, m);
  return m;
}

// A bundle: several relayed states in one frame (the relay's batching, RelayOptions.batchInterval).
//   0 u8 type (0x02) | 1 u8 n (1-32) | n x STATE_BYTES: whole state messages, player bytes set
export const MAX_BUNDLE = 32;
export function encodeBundle(states: readonly Uint8Array[]): Uint8Array {
  const n = Math.min(states.length, MAX_BUNDLE), out = new Uint8Array(2 + n * STATE_BYTES);
  out[0] = MSG.states; out[1] = n;
  for (let i = 0; i < n; i++) out.set(states[i].subarray(0, STATE_BYTES), 2 + i * STATE_BYTES);
  return out;
}
function decodeBundle(r: Reader): NetMessage {
  const n = r.u8();
  if (n < 1 || n > MAX_BUNDLE) r.fail('out of range');
  if (r.d.length !== 2 + n * STATE_BYTES) r.fail(r.d.length < 2 + n * STATE_BYTES ? 'truncated' : 'trailing bytes');
  const states: StateMsg[] = [];
  for (let i = 0; i < n; i++) states.push(stateAt(r, 2 + i * STATE_BYTES));
  r.at = r.d.length;
  return { type: 'states', states };
}

// Times on the wire: the relay clock (seconds since the relay started) in 1e-4 s, mod 2^32 (it wraps every 4.97
// days). A receiver unwraps it next to its own estimate of the relay clock, which is never far off.
export function timeToWire(t: number): number {
  const u = Math.round(fin(t) * TIME_UNITS_PER_S) % 4294967296;
  return u < 0 ? u + 4294967296 : u;
}
export function unwrapTime(wire: number, refS: number): number {
  const ref = Math.round(refS * TIME_UNITS_PER_S);
  let d = (wire - (ref % 4294967296) + 4294967296) % 4294967296;
  if (d >= 2147483648) d -= 4294967296;
  return (ref + d) / TIME_UNITS_PER_S;
}
// Sequence numbers (u16, wrapping): is a newer than b?
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

// ---------------------------------------------------------------------------- reliable messages
export interface PlayerInfo { id: number; name: string; car: string }
export interface BoardEntry {
  player: number;                // 0 once the player has left (the entry stays, by name)
  name: string; car: string;
  best: number;                  // best valid lap (s, to the microsecond)
  sectors: (number | null)[];    // that lap's three sectors (s)
  laps: number;                  // valid laps this player has done in this car
}
export const LEAVE_REASON = { left: 0, timeout: 1, kicked: 2 } as const;
export const ERROR = {
  version: 1,        // the client speaks another protocol version (fatal)
  roomFull: 2,       // fatal
  badName: 3,        // fatal on hello; on a player update the old name stays
  badCar: 4,         // fatal on hello
  badCircuit: 5,     // fatal on hello
  badRoom: 6,        // fatal
  malformed: 7,      // a message did not decode (fatal after repeats)
  rate: 8,           // too many messages (fatal after repeats)
  tooBig: 9,         // fatal
  idle: 10,          // nothing heard for too long (fatal)
  notJoined: 11,     // a message before hello / a second hello (fatal)
  lapRejected: 12,   // the lap claim failed the relay's checks (not fatal)
  badContact: 13,    // not fatal
  serverFull: 14,    // fatal
  shutdown: 15,      // fatal
} as const;

export type NetMessage =
  | StateMsg
  | { type: 'states'; states: StateMsg[] }
  | { type: 'hello'; version: number; room: string; name: string; car: string; circuit: string }
  | { type: 'welcome'; version: number; you: number; room: string; circuit: string; serverTime: number;
      maxPlayers: number; stateHz: number; players: PlayerInfo[]; board: BoardEntry[] }
  | { type: 'joined'; player: PlayerInfo }
  | { type: 'left'; id: number; reason: number }
  | { type: 'player'; player: PlayerInfo }
  | { type: 'ping'; nonce: number; clientTime: number }
  | { type: 'pong'; nonce: number; clientTime: number; serverTime: number }
  | ContactMsg
  | LapMsg
  | { type: 'board'; board: BoardEntry[] }
  | { type: 'restart'; player: number }
  | { type: 'error'; code: number; fatal: boolean; message: string };

// A car-to-car hit as the sender's simulation resolved it, so the other car's client can apply its half if its own
// simulation missed it. impulse: what the sender's car received (N s, world); the other car takes the opposite.
export interface ContactMsg {
  type: 'contact';
  from: number;                  // 0 from a client; the relay sets the sender's id
  to: number;                    // the other car's player id
  timeWire: number;              // relay clock of the hit (as StateMsg.timeWire)
  ix: number; iy: number; iz: number;
  px: number; py: number; pz: number;   // contact point (world, m)
  closing: number;               // closing speed along the contact normal (m/s, >= 0)
}
export interface LapMsg {
  type: 'lap';
  player: number;                // 0 from a client; the relay sets the sender's id
  time: number;                  // lap time (s, microseconds on the wire)
  sectors: (number | null)[];    // three
  valid: boolean;
}
export const MAX_IMPULSE = 1e6, MAX_CLOSING = 200, MAX_LAP_S = 3600;

// ---------------------------------------------------------------------------- encoders
export function encodeMessage(m: NetMessage): Uint8Array {
  if (m.type === 'states') return encodeBundle(m.states.map((x) => encodeMessage(x)));
  if (m.type === 'state') {
    const out = encodeState(m, m.seq, 0);
    view(out).setUint32(4, m.timeWire >>> 0, true); out[1] = m.player & 255;
    return out;
  }
  const w = new Writer();
  w.u8(MSG[m.type]);
  switch (m.type) {
    case 'hello': w.u16(m.version); w.str(m.room); w.str(m.name); w.str(m.car); w.str(m.circuit); break;
    case 'welcome':
      w.u16(m.version); w.u8(m.you); w.str(m.room); w.str(m.circuit); w.f64(m.serverTime);
      w.u8(m.maxPlayers); w.u8(m.stateHz);
      w.u8(m.players.length); for (const p of m.players) writePlayer(w, p);
      writeBoard(w, m.board);
      break;
    case 'joined': case 'player': writePlayer(w, m.player); break;
    case 'left': w.u8(m.id); w.u8(m.reason); break;
    case 'ping': w.u32(m.nonce); w.f64(m.clientTime); break;
    case 'pong': w.u32(m.nonce); w.f64(m.clientTime); w.f64(m.serverTime); break;
    case 'contact':
      w.u8(m.from); w.u8(m.to); w.u32(m.timeWire);
      w.f32(m.ix); w.f32(m.iy); w.f32(m.iz); w.f32(m.px); w.f32(m.py); w.f32(m.pz); w.f32(m.closing);
      break;
    case 'lap': w.u8(m.player); w.u32(usOf(m.time)); for (let k = 0; k < 3; k++) w.u32(usOf(m.sectors[k])); w.u8(m.valid ? 1 : 0); break;
    case 'board': writeBoard(w, m.board); break;
    case 'restart': w.u8(m.player); break;
    case 'error': w.u8(m.code); w.u8(m.fatal ? 1 : 0); w.str(truncUtf8(m.message, MAX_ERROR_BYTES)); break;
  }
  return w.done();
}
function writePlayer(w: Writer, p: PlayerInfo) { w.u8(p.id); w.str(p.name); w.str(p.car); }
function writeBoard(w: Writer, b: BoardEntry[]) {
  w.u8(Math.min(b.length, MAX_BOARD));
  for (const e of b.slice(0, MAX_BOARD)) {
    w.u8(e.player); w.str(e.name); w.str(e.car); w.u32(usOf(e.best));
    for (let k = 0; k < 3; k++) w.u32(usOf(e.sectors[k]));
    w.u16(Math.min(e.laps, 65535));
  }
}
const usOf = (t: number | null | undefined) => (t == null || !Number.isFinite(t) || t < 0 ? NO_TIME : Math.min(NO_TIME - 1, Math.round(t * 1e6)));

// ---------------------------------------------------------------------------- decoder
export type Decoded = { ok: true; msg: NetMessage } | { ok: false; error: string };

export function decodeMessage(data: Uint8Array): Decoded {
  try {
    const r = new Reader(data);
    const msg = decodeBody(r);
    if (r.at !== data.length) r.fail('trailing bytes');
    return { ok: true, msg };
  } catch (e) {
    return { ok: false, error: e instanceof DecodeError ? e.message : 'malformed' };
  }
}

// The protocol version in a hello (or welcome), read without decoding the rest; null if it is neither.
export function helloVersion(data: Uint8Array): number | null {
  if (data.length < 3 || (data[0] !== MSG.hello && data[0] !== MSG.welcome)) return null;
  return data[1] | (data[2] << 8);
}

function decodeBody(r: Reader): NetMessage {
  const type = r.u8();
  switch (type) {
    case MSG.state: return decodeState(r);
    case MSG.states: return decodeBundle(r);
    case MSG.hello: {
      const version = r.u16();
      if (version !== PROTOCOL_VERSION) r.fail('version');
      return { type: 'hello', version, room: r.room(), name: r.str(MAX_NAME_BYTES), car: r.id(), circuit: r.id(true) };
    }
    case MSG.welcome: {
      const version = r.u16();
      if (version !== PROTOCOL_VERSION) r.fail('version');
      const you = r.u8(), room = r.room(), circuit = r.id(), serverTime = r.f64();
      if (serverTime < 0) r.fail('bad time');
      const maxPlayers = r.u8(), stateHz = r.u8(), n = r.u8();
      if (n > MAX_ROSTER || stateHz === 0) r.fail('out of range');
      const players: PlayerInfo[] = [];
      for (let i = 0; i < n; i++) players.push(readPlayer(r));
      return { type: 'welcome', version, you, room, circuit, serverTime, maxPlayers, stateHz, players, board: readBoard(r) };
    }
    case MSG.joined: return { type: 'joined', player: readPlayer(r) };
    case MSG.player: return { type: 'player', player: readPlayer(r) };
    case MSG.left: {
      const id = r.u8(), reason = r.u8();
      if (reason > 2) r.fail('out of range');
      return { type: 'left', id, reason };
    }
    case MSG.ping: return { type: 'ping', nonce: r.u32(), clientTime: r.f64() };
    case MSG.pong: return { type: 'pong', nonce: r.u32(), clientTime: r.f64(), serverTime: r.f64() };
    case MSG.contact: {
      const m: ContactMsg = { type: 'contact', from: r.u8(), to: r.u8(), timeWire: r.u32(),
        ix: r.f32(), iy: r.f32(), iz: r.f32(), px: r.f32(), py: r.f32(), pz: r.f32(), closing: r.f32() };
      if (Math.hypot(m.ix, m.iy, m.iz) > MAX_IMPULSE || !(m.closing >= 0 && m.closing <= MAX_CLOSING)
        || Math.max(Math.abs(m.px), Math.abs(m.py), Math.abs(m.pz)) > 1e5) r.fail('out of range');
      return m;
    }
    case MSG.lap: {
      const player = r.u8(), time = r.time(false)!, sectors = [r.time(true), r.time(true), r.time(true)], f = r.u8();
      if (f > 1 || time > MAX_LAP_S || sectors.some((s) => s != null && s > MAX_LAP_S)) r.fail('out of range');
      return { type: 'lap', player, time, sectors, valid: f === 1 };
    }
    case MSG.board: return { type: 'board', board: readBoard(r) };
    case MSG.restart: return { type: 'restart', player: r.u8() };
    case MSG.error: {
      const code = r.u8(), f = r.u8();
      if (f > 1) r.fail('out of range');
      return { type: 'error', code, fatal: f === 1, message: r.str(MAX_ERROR_BYTES) };
    }
    default: return r.fail('unknown type');
  }
}
function readPlayer(r: Reader): PlayerInfo { return { id: r.u8(), name: r.str(MAX_NAME_BYTES), car: r.id() }; }
function readBoard(r: Reader): BoardEntry[] {
  const n = r.u8();
  if (n > MAX_BOARD) r.fail('out of range');
  const out: BoardEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ player: r.u8(), name: r.str(MAX_NAME_BYTES), car: r.id(), best: r.time(false)!,
      sectors: [r.time(true), r.time(true), r.time(true)], laps: r.u16() });
  }
  return out;
}

// ---------------------------------------------------------------------------- byte helpers
class DecodeError extends Error {}
const utf8 = new TextEncoder(), utf8Strict = new TextDecoder('utf-8', { fatal: true });

class Reader {
  at = 0;
  readonly v: DataView;
  constructor(readonly d: Uint8Array) { this.v = view(d); }
  fail(why: string): never { throw new DecodeError(why); }
  private need(n: number) { if (this.at + n > this.d.length) this.fail('truncated'); const a = this.at; this.at += n; return a; }
  u8() { return this.v.getUint8(this.need(1)); }
  u16() { return this.v.getUint16(this.need(2), true); }
  u32() { return this.v.getUint32(this.need(4), true); }
  f32() { const x = this.v.getFloat32(this.need(4), true); if (!Number.isFinite(x)) this.fail('not finite'); return x; }
  f64() { const x = this.v.getFloat64(this.need(8), true); if (!Number.isFinite(x)) this.fail('not finite'); return x; }
  str(max: number): string {
    const n = this.u8();
    if (n > max) this.fail('string too long');
    const a = this.need(n);
    return utf8Strict.decode(this.d.subarray(a, a + n));   // throws (caught) on invalid UTF-8
  }
  room() { const s = this.str(MAX_ROOM_BYTES); if (!ROOM_RE.test(s)) this.fail('bad room code'); return s; }
  id(empty = false) { const s = this.str(MAX_ID_BYTES); if (!(ID_RE.test(s) || (empty && s === ''))) this.fail('bad id'); return s; }
  time(optional: boolean): number | null {
    const u = this.u32();
    if (u === NO_TIME) { if (!optional) this.fail('missing time'); return null; }
    return u / 1e6;
  }
}

class Writer {
  private b = new Uint8Array(128); private v = view(this.b); private n = 0;
  private room(k: number) {
    if (this.n + k <= this.b.length) return;
    const g = new Uint8Array(Math.max(this.b.length * 2, this.n + k)); g.set(this.b); this.b = g; this.v = view(g);
  }
  u8(x: number) { this.room(1); this.v.setUint8(this.n, x); this.n += 1; }
  u16(x: number) { this.room(2); this.v.setUint16(this.n, x, true); this.n += 2; }
  u32(x: number) { this.room(4); this.v.setUint32(this.n, x >>> 0, true); this.n += 4; }
  f32(x: number) { this.room(4); this.v.setFloat32(this.n, fin(x), true); this.n += 4; }
  f64(x: number) { this.room(8); this.v.setFloat64(this.n, fin(x), true); this.n += 8; }
  str(s: string) {
    const e = utf8.encode(truncUtf8(s, 255));   // (callers keep to their field's limit; this keeps the frame well formed)
    this.u8(e.length); this.room(e.length); this.b.set(e, this.n); this.n += e.length;
  }
  done() { return this.b.slice(0, this.n); }
}

// The longest prefix of `s` that fits in `max` UTF-8 bytes (whole code points).
export function truncUtf8(s: string, max: number): string {
  if (utf8.encode(s).length <= max) return s;
  let out = '', n = 0;
  for (const ch of s) {
    const k = utf8.encode(ch).length;
    if (n + k > max) break;
    out += ch; n += k;
  }
  return out;
}
export const utf8Bytes = (s: string) => utf8.encode(s).length;
export const isRoomCode = (s: string) => ROOM_RE.test(s);
export const isId = (s: string) => ID_RE.test(s);

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const fin = (x: number) => (Number.isFinite(x) ? x : 0);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const q = (x: number, scale: number, max: number) => clamp(Math.round(fin(x) * scale), -max, max);
function setI24(v: DataView, o: number, x: number) { v.setUint16(o, x & 0xffff, true); v.setInt8(o + 2, x >> 16); }
function getI24(v: DataView, o: number) { return v.getUint16(o, true) | (v.getInt8(o + 2) << 16); }

function packQuat(v: DataView, o: number, x: number, y: number, z: number, w: number) {
  let n = Math.hypot(x, y, z, w);
  if (!Number.isFinite(n) || n < 1e-9) { x = 0; y = 0; z = 0; w = 1; n = 1; }
  const c = [x / n, y / n, z / n, w / n];
  let big = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(c[i]) > Math.abs(c[big])) big = i;
  const sign = c[big] < 0 ? -1 : 1;
  const rest: number[] = [];
  for (let i = 0; i < 4; i++) if (i !== big) rest.push(clamp(Math.round((sign * c[i] / Q_RANGE) * Q_MAX) + Q_MAX, 0, 2 * Q_MAX));
  v.setUint16(o, rest[0] | ((big & 1) << 15), true);
  v.setUint16(o + 2, rest[1] | ((big >> 1) << 15), true);
  v.setUint16(o + 4, rest[2], true);
}
function quatParts(v: DataView, o: number) {
  const a = v.getUint16(o, true), b = v.getUint16(o + 2, true), c = v.getUint16(o + 4, true);
  return { big: (a >> 15) | ((b >> 15) << 1), r: [a & 0x7fff, b & 0x7fff, c] };
}
function quatValid(v: DataView, o: number): boolean {
  const { r } = quatParts(v, o);
  let ss = 0;
  for (const k of r) { if (k > 2 * Q_MAX) return false; const x = ((k - Q_MAX) / Q_MAX) * Q_RANGE; ss += x * x; }
  return ss <= 1 + 1e-6;
}
function unpackQuat(v: DataView, o: number, out: { qx: number; qy: number; qz: number; qw: number }) {
  const { big, r } = quatParts(v, o);
  const c = [0, 0, 0, 0];
  let j = 0, ss = 0;
  for (let i = 0; i < 4; i++) {
    if (i === big) continue;
    const x = ((r[j++] - Q_MAX) / Q_MAX) * Q_RANGE;
    c[i] = x; ss += x * x;
  }
  c[big] = Math.sqrt(Math.max(0, 1 - ss));
  const n = Math.hypot(c[0], c[1], c[2], c[3]);
  out.qx = c[0] / n; out.qy = c[1] / n; out.qz = c[2] / n; out.qw = c[3] / n;
}
