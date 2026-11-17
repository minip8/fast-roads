import { DEFAULT_CIRCUIT, NET_CARS, NET_CIRCUITS } from '../src/net/ids';
import {
  type BoardEntry, decodeMessage, encodeBundle, encodeMessage, ERROR, helloVersion, LEAVE_REASON, MAX_BOARD, MAX_BUNDLE, MAX_CLIENT_MSG,
  MAX_GRID, MAX_NAME_BYTES, MSG, NAME_CHARS, type NetMessage, type PlayerInfo, PROTOCOL_VERSION, STATE_BYTES, stateValid,
  truncUtf8, unwrapTime, type WeatherInfo,
} from '../src/net/protocol';
import { defaultSettings, lobbySession, LIGHTS, normaliseSettings, ONE_SHOT_GAP, type RoomSettings, type SessionInfo, type Standing } from '../src/net/race';
import type { Transport } from '../src/net/transport';
import { MAX_WEATHER_KEYS, MAX_WEATHER_T, resolveWeather, seededRandom, WEATHER_STEP, type WeatherKind, weatherKeys } from '../src/net/weather';
import { classify, type Entry, gridOrder } from './weekend';

// ============================================================================
// The relay: rooms of players, a shared clock, the session's lap board, and race weekends (practice, qualifying,
// race) timed on its clock. It runs no physics: each client simulates its own car and the relay passes the car
// states on (the client's own bytes, with the player byte set to the sender's id: a client's claimed id is never
// used). Transport-agnostic: hand it each new connection (accept) and call update() now and then (timeouts) and
// when it asks (RelayOptions.schedule: the next phase deadline); tests run it in-process over loopback.ts,
// server/ws.ts over WebSocket, server/cf/ on Cloudflare. docs/net.md lists the limits and the weekend's rules.
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
  // frames (per-packet TCP/IP overhead is more than a state's 43 bytes) for up to batchInterval of added delay.
  batchInterval: number;
  cars: readonly string[];
  circuits: readonly string[];
  defaultCircuit: string;         // for a hello that does not name one
  minLapSecs: number | Record<string, number>;   // a lap quicker than this is refused (per circuit, or for all)
  // Decides whether a lap claim stands. The default (plausibleLap) checks it against the clock only. A later
  // verifier can replay the lap's inputs headlessly (the claim would then carry them: a new protocol version).
  verifyLap: (claim: LapClaim, opt: RelayOptions) => LapVerdict;
  log: (line: string) => void;
  // Race weekends (docs/net.md, **Race weekends**). Durations are injectable so tests need not wait.
  minute: number;                 // s in a minute of the settings' session lengths (60)
  gridSecs: number;               // s from the race session's start (cars on the grid) to the first light
  lightsHold: [number, number];   // s from the fifth light to lights out, uniform in this range
  resultsSecs: number;            // s the race's results stage lasts before the lobby
  overtimeSecs: number;           // s after timed qualifying's flag for laps under way to finish, at most
  oneShotPrep: number;            // s from one-shot qualifying's start to the cars' release
  oneShotLimit: number;           // s from the last entrant's release (ONE_SHOT_GAP apart) to the session's end, at most
  maxRaceLapSecs: number;         // the race stops at lights out + laps x this, at the latest
  missedStopPenalty: number;      // s added, once the race is over, to a car that made too few pit stops
  hostGrace: number;              // s the host role waits for a host who left to come back (its token)
  pitSpacing: number;             // s two pit stops of a car must be apart at least
  random: () => number;           // tokens, room seeds (Math.random; tests pass a seeded one)
  // Called with the relay time at which update() should next run for a phase deadline (null: none), whenever that
  // changes; the servers set a timer. Without it the deadlines are still met at the next update() or message.
  schedule: ((at: number | null) => void) | null;
}

export interface LapClaim {
  player: number; name: string; car: string; circuit: string;
  time: number; sectors: (number | null)[]; valid: boolean;
  lap: number;                    // the client's lap number (this session)
  crossing: number;               // relay time of the line crossing that ended it, as the client says
  now: number;                    // relay time the claim arrived
  joinedAt: number;               // relay time the player joined
  lastLapAt: number | null;       // relay time of the player's previous accepted lap (arrival)
  lastStateAt: number | null;     // relay time of the player's last car state
  prevLap: number;                // the last accepted lap number this session (0: none)
  prevCrossing: number | null;    // its crossing
  startRef: number;               // the earliest relay time this lap can have started (session start, lights out, the previous crossing)
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
  minute: 60, gridSecs: 15, lightsHold: [0.2, 3], resultsSecs: 30, overtimeSecs: 180, oneShotPrep: 10, oneShotLimit: 420,
  maxRaceLapSecs: 600, missedStopPenalty: 60, hostGrace: 10, pitSpacing: 5,
  random: Math.random, schedule: null,
};

// How far a client's estimate of the relay clock may be off and still have its claims taken.
const SLACK = 1, FUTURE = 1, STALE = 10;

// The lap could have been driven: long enough, sectors adding up, in order, not more laps than time allows (since
// joining, since the last lap, since it could have started), crossing the line no later than now and not long ago,
// and the car was on track (sending states) when it finished.
export function plausibleLap(c: LapClaim, opt: RelayOptions): LapVerdict {
  const min = typeof opt.minLapSecs === 'number' ? opt.minLapSecs : opt.minLapSecs[c.circuit] ?? 0;
  if (!(c.time >= min && c.time <= 3600)) return { ok: false, reason: `lap time ${c.time.toFixed(3)} s out of range` };
  if (c.valid) {
    if (c.sectors.length !== 3 || c.sectors.some((s) => s == null || !(s > 0))) return { ok: false, reason: 'a valid lap needs three sectors' };
    const sum = (c.sectors as number[]).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - c.time) > 0.002) return { ok: false, reason: 'sectors do not add up to the lap' };
  }
  if (c.lap <= c.prevLap) return { ok: false, reason: `lap ${c.lap} out of order (after ${c.prevLap})` };
  if (c.crossing > c.now + FUTURE) return { ok: false, reason: 'line crossing in the future' };
  if (c.crossing < c.now - STALE) return { ok: false, reason: 'line crossing too long ago' };
  if (c.prevCrossing != null && c.crossing <= c.prevCrossing) return { ok: false, reason: 'line crossing before the last one' };
  if (c.now - c.joinedAt < c.time - SLACK) return { ok: false, reason: 'lap longer than the time in the room' };
  if (c.lastLapAt != null && c.now - c.lastLapAt < c.time - SLACK) return { ok: false, reason: 'lap longer than the time since the last one' };
  if (c.crossing - c.startRef < c.time - SLACK) return { ok: false, reason: 'lap started before it could have (session start, lights out or the last lap)' };
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
  token: number;                  // to rejoin as this player (welcome)
  room: Room | null;
  want: string | null;            // the room the connection's address named (its hello must be for it), or null
  name: string; car: string;
  connectedAt: number; joinedAt: number; lastHeard: number;
  lastStateAt: number | null; lastLapAt: number | null;
  lapNo: number; lastCrossing: number | null; lastPitAt: number | null;   // this session
  states: Bucket; reliable: Bucket;
  violations: number; violationsAt: number; rateDrops: number;
  gone: boolean;
  pending: Uint8Array[];           // car states waiting for flush() (batching)
}
interface BoardRow extends BoardEntry { key: string }
interface Departed { token: number; id: number; name: string; car: string; joinedAt: number }
interface RoomWeather extends WeatherInfo { setting: WeatherKind; seed: number }
export interface Room {
  code: string; circuit: string; createdAt: number;
  players: Map<number, Conn>;
  board: BoardRow[];
  nextId: number;
  emptySince: number | null;
  settings: RoomSettings;
  host: number;                   // 0: none
  hostLeftAt: number | null;      // the host left then (the role is held for hostGrace)
  rng: () => number;
  session: SessionInfo;
  weather: RoomWeather;
  entries: Map<number, Entry>;    // the race's cars (race phase)
  done: Set<number>;              // one-shot: who has had their lap; timed qualifying after the flag: who has finished
  results: Standing[] | null;     // the last race's final classification
  departed: Map<number, Departed>;   // by token: players who left, who may come back as themselves
  deadline: number | null;        // the next relay time something is due (session end, host hand-over, weather)
}

export interface RelayStats {
  connections: number; messagesIn: number; bytesIn: number; messagesOut: number; bytesOut: number;
  statesRelayed: number; dropped: number; kicked: number;
}

const MAX_DEPARTED = 64;

export class Relay {
  readonly opt: RelayOptions;
  readonly rooms = new Map<string, Room>();
  readonly stats: RelayStats = { connections: 0, messagesIn: 0, bytesIn: 0, messagesOut: 0, bytesOut: 0, statesRelayed: 0, dropped: 0, kicked: 0 };
  private conns = new Set<Conn>();
  private told: number | null = null;   // the deadline last given to opt.schedule

  constructor(opt: Partial<RelayOptions> & { now: () => number }) {
    this.opt = { ...RELAY_DEFAULTS, ...opt };
  }

  get connectionCount() { return this.conns.size; }

  // The earliest phase deadline of any room (relay time), or null.
  nextDeadline(): number | null {
    let t: number | null = null;
    for (const r of this.rooms.values()) if (r.deadline != null && (t == null || r.deadline < t)) t = r.deadline;
    return t;
  }

  // A new connection (open, or about to be). `room`: the room its address named (roomFromPath), if any; a hello
  // for another room is refused (badRoom).
  accept(t: Transport, opt: { room?: string } = {}) {
    const now = this.opt.now();
    const c: Conn = {
      t, id: 0, token: 0, room: null, want: opt.room ?? null, name: '', car: '', connectedAt: now, joinedAt: 0, lastHeard: now,
      lastStateAt: null, lastLapAt: null, lapNo: 0, lastCrossing: null, lastPitAt: null,
      states: { tokens: this.opt.stateBurst, at: now }, reliable: { tokens: this.opt.reliableBurst, at: now },
      violations: 0, violationsAt: now, rateDrops: 0, gone: false, pending: [],
    };
    if (this.conns.size >= this.opt.maxConnections) { this.sendTo(c, encodeMessage({ type: 'error', code: ERROR.serverFull, fatal: true, message: 'server full' })); t.close('server full'); return; }
    this.conns.add(c);
    this.stats.connections++;
    t.onMessage = (data) => this.receive(c, data);
    t.onClose = () => this.drop(c, LEAVE_REASON.left);
  }

  // Timeouts, phase deadlines and empty rooms. Call every second or so, and when opt.schedule asks.
  update() {
    const now = this.opt.now(), o = this.opt;
    for (const c of this.conns) {
      if (!c.id && now - c.connectedAt > o.helloTimeout) this.kick(c, ERROR.idle, 'no hello', LEAVE_REASON.timeout);
      else if (c.id && now - c.lastHeard > o.idleTimeout) this.kick(c, ERROR.idle, 'timed out', LEAVE_REASON.timeout);
    }
    for (const [code, r] of this.rooms) {
      if (r.emptySince != null && now - r.emptySince >= o.roomLinger) { this.rooms.delete(code); continue; }
      this.advance(r, now);
    }
    this.reschedule();
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
    if (room.deadline != null && now >= room.deadline) { this.advance(room, now); this.reschedule(); }   // a late timer
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
    this.reschedule();
  }

  private hello(c: Conn, data: Uint8Array, now: number) {
    const v = helloVersion(data);
    if (v !== null && v !== PROTOCOL_VERSION) {
      return this.kick(c, ERROR.version, `this relay speaks protocol ${PROTOCOL_VERSION}, the game ${v}: update the game (reload the page)`, LEAVE_REASON.kicked);
    }
    const d = decodeMessage(data);
    if (!d.ok) return this.kick(c, ERROR.malformed, d.error, LEAVE_REASON.kicked);
    const m = d.msg;
    if (m.type !== 'hello') return this.kick(c, ERROR.notJoined, 'hello first', LEAVE_REASON.kicked);
    const o = this.opt;
    if (c.want !== null && m.room !== c.want) return this.kick(c, ERROR.badRoom, `this connection is for room ${c.want}, not ${m.room}`, LEAVE_REASON.kicked);
    const name = sanitiseName(m.name);
    if (!name) return this.kick(c, ERROR.badName, 'empty name', LEAVE_REASON.kicked);
    if (!o.cars.includes(m.car)) return this.kick(c, ERROR.badCar, `unknown car ${m.car}`, LEAVE_REASON.kicked);
    let room = this.rooms.get(m.room);
    if (room && m.mode === 'create') return this.kick(c, ERROR.roomTaken, `room ${m.room} already exists`, LEAVE_REASON.kicked);
    if (!room && m.mode === 'join') return this.kick(c, ERROR.noRoom, `no room ${m.room}`, LEAVE_REASON.kicked);
    let created = false;
    if (!room) {
      const circuit = m.circuit || o.defaultCircuit;
      if (!o.circuits.includes(circuit)) return this.kick(c, ERROR.badCircuit, `unknown circuit ${circuit}`, LEAVE_REASON.kicked);
      if (this.rooms.size >= o.maxRooms) return this.kick(c, ERROR.serverFull, 'too many rooms', LEAVE_REASON.kicked);
      const seed = u32(o.random());
      room = {
        code: m.room, circuit, createdAt: now, players: new Map(), board: [], nextId: 1, emptySince: null,
        settings: defaultSettings(circuit), host: 0, hostLeftAt: null, rng: seededRandom(seed), session: lobbySession(now),
        weather: dryWeather(now), entries: new Map(), done: new Set(), results: null, departed: new Map(), deadline: null,
      };
      this.rooms.set(m.room, room);
      created = true;
      o.log(`room ${room.code} opened (${circuit})`);
    }
    if (room.deadline != null && now >= room.deadline) this.advance(room, now);
    // rejoining with a token: the same player again (a reload, a new connection); an old connection still open goes
    const live = m.token ? [...room.players.values()].find((p) => p.token === m.token) : undefined;
    if (live) this.kick(live, ERROR.replaced, 'rejoined on another connection', LEAVE_REASON.replaced);
    const back = m.token ? room.departed.get(m.token) : undefined;
    if (room.players.size >= o.maxPlayers) return this.kick(c, ERROR.roomFull, `room ${room.code} is full`, LEAVE_REASON.kicked);
    let id = back && !room.players.has(back.id) ? back.id : 0;
    if (!id) {
      id = room.nextId;
      while (room.players.has(id)) id = (id % 255) + 1;   // ids are not reused soon: late packets of a leaver stay theirs
      room.nextId = (id % 255) + 1;
    }
    if (back) room.departed.delete(back.token);
    let token = back?.token ?? 0;
    while (!token || [...room.players.values()].some((p) => p.token === token)) token = u32(o.random()) || 1;
    c.id = id; c.token = token; c.room = room; c.car = m.car; c.name = uniqueName(room, name, null);
    c.joinedAt = back && back.id === id ? back.joinedAt : now;
    room.players.set(id, c); room.emptySince = null;
    if (back && back.id === id) this.returned(room, c);
    if (created) room.host = id;
    else if (room.host === id) room.hostLeftAt = null;
    else if (room.hostLeftAt != null && now >= room.hostLeftAt + o.hostGrace) this.assignHost(room);
    const me: PlayerInfo = { id, name: c.name, car: c.car };
    const st = this.standingsNow(room);
    this.sendTo(c, encodeMessage({
      type: 'welcome', version: PROTOCOL_VERSION, you: id, token, room: room.code, serverTime: now,
      maxPlayers: o.maxPlayers, stateHz: o.stateHz, host: room.host, players: [...room.players.values()].map(info), board: room.board,
      settings: room.settings, session: room.session, weather: wireWeather(room.weather), final: st.final, standings: st.standings,
    }));
    this.broadcast(room, encodeMessage({ type: 'joined', player: me }), c);
    o.log(`room ${room.code}: ${id} ${JSON.stringify(c.name)} ${back ? 'rejoined' : 'joined'} (${c.car}), ${room.players.size} in`);
    this.setDeadline(room);
    this.reschedule();
  }

  // A player back with its token: its board rows and race entry are its own again.
  private returned(room: Room, c: Conn) {
    for (const r of room.board) if (r.player === 0 && r.key.startsWith(`${c.id}:`)) r.player = c.id;
    const e = room.entries.get(c.id);
    if (e && e.status === 'dnf' && room.session.phase === 'race' && room.session.stage !== 'results') {
      e.status = 'racing';
      this.broadcastStandings(room, false);
    }
  }

  private handle(c: Conn, room: Room, m: NetMessage, data: Uint8Array, now: number) {
    switch (m.type) {
      case 'ping': return this.sendTo(c, encodeMessage({ type: 'pong', nonce: m.nonce, clientTime: m.clientTime, serverTime: now }));
      case 'player': {
        const name = sanitiseName(m.player.name);
        if (!name) return this.error(c, ERROR.badName, 'empty name');
        if (!this.opt.cars.includes(m.player.car)) return this.error(c, ERROR.badCar, `unknown car ${m.player.car}`);
        if (room.settings.car && m.player.car !== room.settings.car) return this.error(c, ERROR.badCar, `this room allows only ${room.settings.car}`);
        c.name = uniqueName(room, name, c); c.car = m.player.car;
        const e = room.entries.get(c.id);
        if (e) { e.name = c.name; e.car = c.car; }
        return this.broadcast(room, encodeMessage({ type: 'player', player: info(c) }));
      }
      case 'contact': {
        const other = room.players.get(m.to);
        if (!other || other === c) return this.error(c, ERROR.badContact, 'no such car');
        const out = data.slice(); out[1] = c.id;
        return this.sendTo(other, out);
      }
      case 'lap': return this.lap(c, room, m, data, now);
      case 'pit': return this.pit(c, room, m, data, now);
      case 'restart': {
        const out = data.slice(); out[1] = c.id;
        return this.broadcast(room, out, c);
      }
      case 'settings': return this.settings(c, room, m.settings);
      case 'control': return this.control(c, room, m.action, now);
      case 'hello': return this.kick(c, ERROR.notJoined, 'already joined', LEAVE_REASON.kicked);
      default: return this.violation(c, now, ERROR.malformed, `${m.type} is not a client message`);
    }
  }

  // ------------------------------------------------------------------------ the host's controls
  private isHost(c: Conn, room: Room) { return room.host === c.id; }

  private settings(c: Conn, room: Room, s: RoomSettings) {
    if (!this.isHost(c, room)) return this.error(c, ERROR.notHost, 'only the host changes the settings');
    if (room.session.phase !== 'lobby') return this.error(c, ERROR.badPhase, 'settings change only in the lobby');
    if (!this.opt.circuits.includes(s.circuit)) return this.error(c, ERROR.badCircuit, `unknown circuit ${s.circuit}`);
    if (s.car && !this.opt.cars.includes(s.car)) return this.error(c, ERROR.badCar, `unknown car ${s.car}`);
    const n = normaliseSettings(s), moved = n.circuit !== room.circuit;
    room.settings = n; room.circuit = n.circuit;
    if (moved) {   // lap times elsewhere mean nothing here
      room.board = []; room.results = null;
      this.broadcast(room, encodeMessage({ type: 'board', board: room.board }));
      this.opt.log(`room ${room.code}: circuit now ${n.circuit}`);
    }
    this.broadcast(room, encodeMessage({ type: 'settings', settings: n }));
  }

  private control(c: Conn, room: Room, action: 'start' | 'skip' | 'abort', now: number) {
    if (!this.isHost(c, room)) return this.error(c, ERROR.notHost, 'only the host runs the sessions');
    const lobby = room.session.phase === 'lobby';
    if (action === 'start') {
      if (!lobby) return this.error(c, ERROR.badPhase, 'the weekend is already under way');
      this.opt.log(`room ${room.code}: weekend started`);
      this.afterPractice(room, 0, now);
    } else if (lobby) return this.error(c, ERROR.badPhase, `nothing to ${action} in the lobby`);
    else if (action === 'skip') this.skip(room, now);
    else { this.opt.log(`room ${room.code}: weekend aborted`); this.toLobby(room, now); }
    this.setDeadline(room);
  }

  // The host ends the current session (or stage) now.
  private skip(room: Room, at: number) {
    const s = room.session;
    if (s.phase === 'practice') return this.afterPractice(room, s.index, at);
    if (s.phase === 'qualifying') return this.startRace(room, at);
    if (s.stage === 'results') return this.toLobby(room, at);
    return this.finishRace(room, at);
  }

  // ------------------------------------------------------------------------ phases
  // Runs every deadline due by `now`, each at its own time, so a late timer changes nothing but when it is seen.
  private advance(room: Room, now: number) {
    for (let k = 0; k < 32 && room.deadline != null && now >= room.deadline; k++) {
      const at = room.deadline, s = room.session, o = this.opt;
      if (room.hostLeftAt != null && room.players.size && at >= room.hostLeftAt + o.hostGrace) this.assignHost(room);
      if (s.end != null && at >= s.end) this.stageEnded(room, s.end);
      const w = room.weather, due = weatherDue(w);
      if (due != null && at >= due) this.extendWeather(room, at);
      this.setDeadline(room);
    }
  }

  private setDeadline(room: Room) {
    const s = room.session, o = this.opt, w = weatherDue(room.weather);
    let t: number | null = s.end;
    const consider = (x: number | null) => { if (x != null && (t == null || x < t)) t = x; };
    if (room.hostLeftAt != null && room.players.size) consider(room.hostLeftAt + o.hostGrace);
    consider(w);
    room.deadline = t;
  }

  private reschedule() {
    if (!this.opt.schedule) return;
    const t = this.nextDeadline();
    if (t === this.told) return;
    this.told = t;
    this.opt.schedule(t);
  }

  private stageEnded(room: Room, at: number) {
    const s = room.session;
    if (s.phase === 'practice') return this.afterPractice(room, s.index, at);
    if (s.phase === 'qualifying') {
      if (s.oneShot || s.stage === 'finishing') return this.startRace(room, at);
      // the flag: laps under way may finish (each driver's next crossing), for overtimeSecs at most
      s.stage = 'finishing'; s.finishAt = at; s.end = at + this.opt.overtimeSecs;
      room.done.clear();
      this.broadcastSession(room);
      return this.qualifyingDone(room, at);
    }
    if (s.phase === 'race') return s.stage === 'results' ? this.toLobby(room, at) : this.finishRace(room, at);
  }

  private afterPractice(room: Room, index: number, at: number) {
    const st = room.settings;
    if (index < st.practice) {
      return this.startSession(room, at, { phase: 'practice', index: index + 1, collisions: true, end: at + st.practiceMinutes * this.opt.minute });
    }
    if (st.qualifying === 'timed') return this.startSession(room, at, { phase: 'qualifying', collisions: true, end: at + st.qualifyingMinutes * this.opt.minute });
    if (st.qualifying === 'oneShot') {
      // released one at a time, ONE_SHOT_GAP apart (race.ts oneShotRelease): the end allows for the last of them
      const goAt = at + this.opt.oneShotPrep, grid = this.joinOrder(room);
      return this.startSession(room, at, { phase: 'qualifying', collisions: false, oneShot: true, goAt,
        end: goAt + Math.max(0, grid.length - 1) * ONE_SHOT_GAP + this.opt.oneShotLimit, grid });
    }
    return this.startRace(room, at);
  }

  private startRace(room: Room, at: number) {
    const st = room.settings, o = this.opt;
    const best = new Map<number, number>();
    if (room.session.phase === 'qualifying') for (const r of room.board) if (r.player && !(best.get(r.player)! <= r.best)) best.set(r.player, r.best);
    const grid = gridOrder(st.grid, [...room.players.values()].map((p) => ({ id: p.id, joinedAt: p.joinedAt })), best, room.rng).slice(0, MAX_GRID);
    room.entries = new Map(grid.map((id, slot) => {
      const p = room.players.get(id)!;
      return [id, { player: id, name: p.name, car: p.car, grid: slot, status: 'racing', laps: 0, lastCrossing: null, best: null, pits: 0, invalid: 0 }];
    }));
    const lightsAt = at + o.gridSecs, [h0, h1] = o.lightsHold;
    const goAt = lightsAt + (LIGHTS - 1) + h0 + room.rng() * (h1 - h0);
    this.startSession(room, at, { phase: 'race', collisions: st.collisions, lightsAt, goAt, end: goAt + st.raceLaps * o.maxRaceLapSecs, grid });
    this.opt.log(`room ${room.code}: race, ${grid.length} on the grid`);
    this.broadcastStandings(room, false);
    this.raceDone(room, at);
  }

  private startSession(room: Room, at: number, s: Partial<SessionInfo> & Pick<SessionInfo, 'phase'>) {
    const seed = u32(room.rng());
    room.session = { ...lobbySession(at), index: 0, oneShot: false, ...s, seed, stage: 'running' };
    if (s.phase !== 'race') room.entries = new Map();
    room.done = new Set();
    room.board = [];
    for (const p of room.players.values()) { p.lapNo = 0; p.lastCrossing = null; p.lastPitAt = null; }
    room.weather = makeWeather(room.settings.weather, seed, at);
    this.broadcastSession(room);
    this.broadcast(room, encodeMessage({ type: 'weather', weather: wireWeather(room.weather) }));
    this.broadcast(room, encodeMessage({ type: 'board', board: room.board }));
    this.setDeadline(room);
  }

  private toLobby(room: Room, at: number) {
    room.session = lobbySession(at);
    room.entries = new Map(); room.done = new Set(); room.board = [];
    for (const p of room.players.values()) { p.lapNo = 0; p.lastCrossing = null; p.lastPitAt = null; }
    room.weather = dryWeather(at);
    this.broadcastSession(room);
    this.broadcast(room, encodeMessage({ type: 'weather', weather: wireWeather(room.weather) }));
    this.broadcast(room, encodeMessage({ type: 'board', board: room.board }));
    if (room.results) this.broadcastStandings(room, true);
    this.setDeadline(room);
  }

  // The race is over (all finished, the time allowed ran out, the host ended it): the classification is final.
  private finishRace(room: Room, at: number) {
    const s = room.session;
    for (const e of room.entries.values()) if (e.status === 'racing') e.status = 'outOfTime';
    s.stage = 'results'; s.end = at + this.opt.resultsSecs;
    room.results = this.classification(room, true);
    this.broadcastSession(room);
    this.broadcastStandings(room, true);
    this.opt.log(`room ${room.code}: race over`);
    this.setDeadline(room);
  }

  // Ends the race once nobody is left racing: everyone finished or gone (or nobody started).
  private raceDone(room: Room, at: number) {
    const s = room.session;
    if (s.phase !== 'race' || s.stage === 'results') return;
    const racing = [...room.entries.values()].filter((e) => e.status === 'racing');
    if (!racing.length) this.finishRace(room, at);
  }

  // One-shot qualifying ends when everyone taking part has had their lap; timed qualifying after the flag when
  // everyone still in the room has crossed the line.
  private qualifyingDone(room: Room, at: number) {
    const s = room.session;
    if (s.phase !== 'qualifying') return;
    const who = s.oneShot ? s.grid.filter((id) => room.players.has(id)) : [...room.players.keys()];
    if (s.stage === 'finishing' || s.oneShot) if (who.every((id) => room.done.has(id))) this.startRace(room, at);
  }

  private assignHost(room: Room) {
    const next = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id)[0];
    if (!next) return;
    room.host = next.id; room.hostLeftAt = null;
    this.broadcast(room, encodeMessage({ type: 'host', id: next.id }));
    this.opt.log(`room ${room.code}: host now ${next.id}`);
  }

  private extendWeather(room: Room, at: number) {
    const w = room.weather;
    const first = Math.max(0, Math.floor((at - w.origin) / WEATHER_STEP) - 2);
    w.keys = weatherKeys(w.setting, w.seed, first, MAX_WEATHER_KEYS);
    this.broadcast(room, encodeMessage({ type: 'weather', weather: wireWeather(w) }));
  }

  private joinOrder(room: Room) {
    return gridOrder('joinOrder', [...room.players.values()].map((p) => ({ id: p.id, joinedAt: p.joinedAt })), new Map(), room.rng).slice(0, MAX_GRID);
  }

  private classification(room: Room, final: boolean): Standing[] {
    const s = room.session, st = room.settings;
    return classify(room.entries.values(), { goAt: s.goAt ?? s.start, invalidPenalty: st.invalidPenalty, pitStops: st.pitStops,
      missedStopPenalty: this.opt.missedStopPenalty, final });
  }
  private standingsNow(room: Room): { final: boolean; standings: Standing[] } {
    const s = room.session;
    if (s.phase === 'race') return { final: s.stage === 'results', standings: s.stage === 'results' && room.results ? room.results : this.classification(room, false) };
    return { final: true, standings: room.results ?? [] };
  }
  private broadcastStandings(room: Room, final: boolean) {
    const standings = final && room.results ? room.results : this.classification(room, final);
    this.broadcast(room, encodeMessage({ type: 'standings', final, standings }));
  }
  private broadcastSession(room: Room) { this.broadcast(room, encodeMessage({ type: 'session', session: room.session })); }

  // ------------------------------------------------------------------------ laps and pit stops
  private lap(c: Conn, room: Room, m: Extract<NetMessage, { type: 'lap' }>, data: Uint8Array, now: number) {
    const s = room.session, refuse = (reason: string) => {
      this.opt.log(`room ${room.code}: lap by ${c.id} refused: ${reason}`);
      this.error(c, ERROR.lapRejected, reason);
    };
    if (room.settings.car && c.car !== room.settings.car) return refuse(`this room allows only ${room.settings.car}`);
    const crossing = unwrapTime(m.crossingWire, now);
    let startRef = Math.max(s.start, c.lastCrossing ?? -Infinity);
    const entry = room.entries.get(c.id);
    if (s.phase === 'race') {
      if (!entry) return refuse('spectating: not in this race');
      if (s.stage === 'results') return refuse('the race is over');
      if (entry.status !== 'racing') return refuse(`not racing (${entry.status})`);
      startRef = Math.max(s.goAt!, entry.lastCrossing ?? -Infinity, c.lastCrossing ?? -Infinity);
    } else if (s.phase === 'qualifying' && s.oneShot) {
      if (!s.grid.includes(c.id)) return refuse('not in this qualifying (joined after it started)');
      if (room.done.has(c.id)) return refuse('one lap only');
      startRef = Math.max(s.goAt!, c.lastCrossing ?? -Infinity);
    } else if (s.phase === 'qualifying' && s.stage === 'finishing') {
      if (room.done.has(c.id)) return refuse('the session is over');
      if (crossing - m.time > s.finishAt! + SLACK) return refuse('lap started after the flag');
    }
    const verdict = this.opt.verifyLap({
      player: c.id, name: c.name, car: c.car, circuit: room.circuit, time: m.time, sectors: m.sectors, valid: m.valid,
      lap: m.lap, crossing, now, joinedAt: c.joinedAt, lastLapAt: c.lastLapAt, lastStateAt: c.lastStateAt,
      prevLap: c.lapNo, prevCrossing: c.lastCrossing, startRef,
    }, this.opt);
    if (!verdict.ok) return refuse(verdict.reason);
    c.lastLapAt = now; c.lapNo = m.lap; c.lastCrossing = crossing;
    const out = data.slice(); out[1] = c.id;
    this.broadcast(room, out);
    if (m.valid) this.boardLap(room, c, m.time, m.sectors);
    if (s.phase === 'race' && entry) return this.raceLap(room, entry, crossing, m.time, m.valid, now);
    if (s.phase === 'qualifying' && (s.oneShot || s.stage === 'finishing')) { room.done.add(c.id); this.qualifyingDone(room, now); }
  }

  private boardLap(room: Room, c: Conn, time: number, sectors: (number | null)[]) {
    const key = `${c.id}:${c.car}`;
    let row = room.board.find((r) => r.key === key && r.player === c.id);
    if (!row) { row = { key, player: c.id, name: c.name, car: c.car, best: time, sectors, laps: 0 }; room.board.push(row); }
    row.laps++; row.name = c.name;
    if (time < row.best) { row.best = time; row.sectors = sectors; }
    room.board.sort((a, b) => a.best - b.best);
    if (room.board.length > MAX_BOARD) room.board.length = MAX_BOARD;
    this.broadcast(room, encodeMessage({ type: 'board', board: room.board }));
  }

  private raceLap(room: Room, e: Entry, crossing: number, time: number, valid: boolean, now: number) {
    const s = room.session;
    e.laps++; e.lastCrossing = crossing;
    if (valid) e.best = e.best == null ? time : Math.min(e.best, time);
    else e.invalid++;
    if (s.stage === 'running' && e.laps >= room.settings.raceLaps) {   // the winner: everyone else finishes at their next crossing
      e.status = 'finished';
      s.stage = 'finishing'; s.finishAt = crossing; s.end = crossing + room.settings.finishSecs;
      this.broadcastSession(room);
      this.opt.log(`room ${room.code}: ${e.player} won`);
    } else if (s.stage === 'finishing' && crossing > s.finishAt!) e.status = 'finished';
    this.broadcastStandings(room, false);
    this.raceDone(room, now);
    this.setDeadline(room);
  }

  private pit(c: Conn, room: Room, m: Extract<NetMessage, { type: 'pit' }>, data: Uint8Array, now: number) {
    const s = room.session, at = unwrapTime(m.timeWire, now), refuse = (reason: string) => this.error(c, ERROR.pitRejected, reason);
    if (at > now + FUTURE || at < now - STALE) return refuse('pit stop time out of range');
    if (c.lastPitAt != null && at < c.lastPitAt + this.opt.pitSpacing) return refuse('too soon after the last stop');
    const entry = room.entries.get(c.id);
    if (s.phase === 'race') {
      if (!entry) return refuse('spectating: not in this race');
      if (s.stage === 'results' || entry.status !== 'racing') return refuse('not racing');
      if (at < s.goAt!) return refuse('before the start');
    }
    c.lastPitAt = at;
    const out = data.slice(); out[1] = c.id;
    this.broadcast(room, out);
    if (s.phase === 'race' && entry) { entry.pits++; this.broadcastStandings(room, false); }
  }

  // ------------------------------------------------------------------------
  private relayState(p: Conn, state: Uint8Array) {
    if (!this.opt.batchInterval) return this.sendTo(p, state, 'unreliable');
    const k = p.pending.findIndex((q) => q[1] === state[1]);   // a newer state from the same car replaces the queued one
    if (k >= 0) p.pending[k] = state; else p.pending.push(state);
    if (p.pending.length >= MAX_BUNDLE) { this.sendTo(p, encodeBundle(p.pending), 'unreliable'); p.pending = []; }
  }

  private error(c: Conn, code: number, message: string) {
    this.sendTo(c, encodeMessage({ type: 'error', code, fatal: false, message }));
  }

  private violation(c: Conn, now: number, code: number, message: string) {
    c.violations = Math.max(0, c.violations - 2 * (now - c.violationsAt)) + 1;
    c.violationsAt = now;
    if (c.violations > this.opt.maxViolations) return this.kick(c, code, `${message} (too often)`, LEAVE_REASON.kicked);
    if (c.violations === 1 || code !== ERROR.rate) this.error(c, code, message);
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
    const now = this.opt.now();
    room.players.delete(c.id);
    room.departed.set(c.token, { token: c.token, id: c.id, name: c.name, car: c.car, joinedAt: c.joinedAt });
    if (room.departed.size > MAX_DEPARTED) room.departed.delete(room.departed.keys().next().value!);
    for (const r of room.board) if (r.player === c.id) r.player = 0;
    this.broadcast(room, encodeMessage({ type: 'left', id: c.id, reason }));
    if (!room.players.size) room.emptySince = now;
    this.opt.log(`room ${room.code}: ${c.id} left, ${room.players.size} in`);
    if (reason === LEAVE_REASON.replaced) return;   // coming straight back: keeps its host role and race entry
    if (room.host === c.id) {
      room.hostLeftAt = now;
      if (this.opt.hostGrace <= 0) this.assignHost(room);
    }
    const s = room.session, e = room.entries.get(c.id);
    if (e && s.phase === 'race' && s.stage !== 'results' && e.status === 'racing') {
      e.status = 'dnf';
      this.broadcastStandings(room, false);
      this.raceDone(room, now);
    }
    if (s.phase === 'qualifying') this.qualifyingDone(room, now);
    this.setDeadline(room);
    this.reschedule();
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
const u32 = (x: number) => Math.floor(x * 4294967296) >>> 0;

function makeWeather(setting: WeatherKind, seed: number, origin: number): RoomWeather {
  return { setting, seed, origin, kind: resolveWeather(setting, seed), keys: weatherKeys(setting, seed, 0, MAX_WEATHER_KEYS) };
}
const dryWeather = (origin: number) => makeWeather('dry', 0, origin);
const wireWeather = (w: RoomWeather): WeatherInfo => ({ origin: w.origin, kind: w.kind, keys: w.keys });
// When the keyframes need extending: ten minutes before the last one (none for dry weather or at the wire's limit).
function weatherDue(w: RoomWeather): number | null {
  const last = w.keys[w.keys.length - 1];
  if (w.kind === 'dry' || !last || last.t >= MAX_WEATHER_T - WEATHER_STEP) return null;
  return w.origin + last.t - 600;
}

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
