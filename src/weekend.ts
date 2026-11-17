import type { CompoundId } from './conditions';
import { DT } from './config';
import { CAR_REASON, COMPOUND, oneShotRelease, type NetClient, type NetEvent, type Phase, type RaceStage, type SessionInfo, type Stage, type StandingStatus } from './net';
import { buildPitLane, enablePitLane, gridSlots, laneDist, laneIndex, laneLimit, laneZone, PIT, type GridSlot, type PitLane } from './raceGeometry';
import type { Session } from './sim';
import { clearStore } from './timing';
import { pointAt, projectOnTrack, type TrackPos } from './track';
import type { TrackDef } from './tracks';
import { fmtTime } from './util';
import type { DriveInput } from './vehicle';

// ============================================================================
// Our car in a room's race weekend (docs/net.md, **In the game**): where it is put at each session, holding it on the
// grid until the lights go out, the race's standing first lap, the pit lane (limiter, box, service, the stop
// reported), recoveries, which laps are sent, the conditions (tyre wear, the relay's weather) and the live running
// order. Multiplayer owns one and calls it around every tick; it has no DOM, so the tests run it as the game does.
// What a HUD or menu needs is plain state here (`phase`, `pit`, `order`, `startCompound`, ...).
// ============================================================================
export const RECOVERY_SECS = 5;       // s a recovered car is held where it was put back: the cost of a recovery
const CONDITIONS_EVERY = 0.5;         // s between conditions updates (wetness moves slowly)
const ORDER_EVERY = 0.1;              // s between running-order updates
const GAP_BUCKET = 10;                // m: the running order's timing loops
// One-shot qualifying: a car due out waits while another car on the track is about to pass the start spot or has just
// passed it (from CLEAR_BEHIND m before it to CLEAR_AHEAD m after it), so it never joins in front of a car on its lap
// nor right behind one; at most ONE_SHOT_WAIT s, in case that car has stopped there.
const CLEAR_BEHIND = 500, CLEAR_AHEAD = 200, ONE_SHOT_WAIT = 15;
// The pit request's assisted stop: in the lane the limiter's speed falls as braking at BOX_DECEL m/s² down to a stop at
// the box's middle allows (docs/net.md, **The pit request**).
export const BOX_DECEL = 3;
const WORN = 0.75;                    // tread worn (0..1) from which the HUD suggests a stop
const PIT_HELP_SECS = 12;             // s the one-line explanation of pit stops stays up

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// The relay's compound numbers (race.ts COMPOUND) for ours; the drift car's all-weather tyre has none.
export const COMPOUND_CODE: Record<CompoundId, number> = {
  soft: COMPOUND.soft, medium: COMPOUND.medium, hard: COMPOUND.hard, intermediate: COMPOUND.inter, wet: COMPOUND.wet, allweather: COMPOUND.unknown,
};
export const COMPOUND_LETTER = ['', 'S', 'M', 'H', 'I', 'W', '', ''];

// One car in the live running order (a race), or on the board (other sessions: by best lap).
export interface RaceEntry {
  id: number; name: string; car: string; self: boolean;
  pos: number;                        // 1-based
  laps: number;                       // completed
  dist: number;                       // m driven since the start (the race), for the order
  gap: number | null;                 // s behind the leader (null: the leader, or more than a lap down: see lapsDown)
  lapsDown: number;
  status: StandingStatus;
  compound: number;                   // COMPOUND
  pits: number;                       // stops made
  inPits: boolean;
  penalty: number;                    // s
}

export interface PitState {
  zone: 'track' | 'near' | 'lane';
  inLane: boolean;                    // in the pit lane (a ghost; the limiter acts on the entry ramp and the limited stretch)
  limiter: boolean;                   // the limiter is holding the car's speed down this tick
  dist: number;                       // m along the lane (while in it)
  service: number;                    // s of service left (0: none under way)
  serviceTotal: number;
  stops: number;                      // stops made this session
  stopped: boolean;                   // this visit: serviced (else a drive-through so far)
  passedBox: boolean;                 // this visit: the car has gone past the box
}

// What the HUD shows to guide a pit stop (Weekend.pitGuide): the step and what it needs.
export type PitGuide =
  | { step: 'entry'; dist: number; side: 1 | -1 }        // box this lap: the pit entry dist m ahead, on that side
  | { step: 'lane'; box: number; limiter: boolean }      // in the lane, the box `box` m ahead (the limiter on)
  | { step: 'box'; box: number }                         // stop in the box (m to its middle; negative: past it)
  | { step: 'service'; left: number; total: number }     // the service under way (s left)
  | { step: 'go' }                                       // serviced: drive out
  | { step: 'through' };                                 // in the lane without a request: driving through

type Notify = (kind: 'flag' | 'race' | 'error', text: string, sub?: string) => void;

// Per car in the running order.
interface Runner { dist: number; s: number; seen: boolean; hint: number; times: Float64Array; ids: Int32Array; last: number; laps: number }

export class Weekend {
  readonly lane: PitLane;
  private grid: GridSlot[] = [];
  // the session as we last acted on it
  phase: Phase = 'lobby'; index = 0; stage: Stage = 'running';
  raceStage: RaceStage | null = null;
  private key = '';
  // tyres: the set to start each session on (null: by the weather), and the set the next stop or restart fits
  startCompound: CompoundId | null = null;
  nextCompound: CompoundId;
  readonly pit: PitState = { zone: 'track', inLane: false, limiter: false, dist: 0, service: 0, serviceTotal: 0, stops: 0, stopped: false, passedBox: false };
  // The pit request ("box this lap", the `pit` key): guidance to the box, and the limiter stops the car in it. Entering
  // the lane turns it on; the key turns it off again (a drive-through). Off once the stop is made and the car is out.
  pitRequest = false;
  pitHelp: string | null = null;      // a one-line explanation of pit stops, the first time in a weekend
  pitHelpFor = 0;                     // s it stays up
  private pitExplained = false;
  private compoundChosen = false;     // the player picked the next tyres this session (else the weather may)
  private lastLapIn = false;          // a race: our last lap is in (the relay's word on our finish may still be coming)
  held = false;                       // on the grid (or one-shot's start spot) until the release
  recovering = 0;                     // s left held after a recovery
  parked = false;                     // the player is in the menu during a race: the car brakes to a stop, a ghost
  finished = false;                   // our session is over (race finished, one-shot lap or qualifying's last lap done)
  spectator = false;                  // in a race we are not in
  raceLaps = 0;                       // laps we completed in this race
  order: RaceEntry[] = [];            // the race's live running order (empty outside a race)
  gapAhead: number | null = null; gapBehind: number | null = null;   // s to the car ahead / behind in the race
  aheadId = 0; behindId = 0;
  rain = 0; wetness = 0;              // the relay's weather now (drawn and heard by the game)
  private oneShotGo = false;          // one-shot: released this session
  private parkPending = false;        // one-shot: lap done, the car goes back to its spot in the pit lane
  readonly oneShotDone = new Set<number>();   // one-shot: entrants whose lap is in (the relay accepted it)
  private goSim: number | null = null;   // sim time of lights out
  private orderWait = 0;
  private lastPenalty = 0;
  private wasRaining = false; private wasWet = false;
  private runners = new Map<number, Runner>();
  private readonly proj: TrackPos = { i: -1, s: 0, lat: 0 };

  constructor(readonly net: NetClient, readonly session: Session, readonly def: TrackDef, private readonly notify: Notify) {
    this.lane = buildPitLane(session.track, def);
    enablePitLane(session.track, this.lane);
    this.nextCompound = session.car.compound.id;
    session.setStoreTag('.mp');
    session.autoReset = () => this.autoReset();
  }

  // The weekend's state no more: the time trial's track, conditions and best times (leaving the room).
  dispose() {
    const s = this.session;
    enablePitLane(s.track, null);
    s.autoReset = null;
    s.timing.runup = this.def.startBack;
    s.setConditions({ wearScale: 0, rain: 0, wetness: 0 });
    s.setStoreTag('');
    s.car.fitTyres(s.car.compounds[0].id, 'lap');
    s.restart();
  }

  // ------------------------------------------------------------------------ for the HUD and the menu
  get inRace() { return this.phase === 'race'; }
  // The game keeps simulating our car while the menu is open: a race we are in (the race does not stop for us).
  get keepsRunning() { return this.phase === 'race' && !this.spectator && this.stage !== 'results'; }
  get mandatoryStops() { return this.phase === 'race' ? this.net.settings.pitStops : 0; }
  // Why our car is shown as it is (CAR_REASON), and whether that makes it a ghost.
  get reason(): number {
    if (this.pit.inLane) return CAR_REASON.pits;
    if (this.spectator) return CAR_REASON.spectator;
    if (this.parked) return CAR_REASON.paused;
    if (this.finished) return CAR_REASON.finished;
    if (this.recovering > 0 || this.oneShotGhost) return CAR_REASON.ghost;
    return CAR_REASON.none;
  }
  // What the timing panel says about the lap (null: the usual): in a race the race's lap of its total (lap 1 from the
  // grid, so the out-lap words do not apply), and no lap clock once our session is over.
  get lapState(): { text: string; clock: boolean } | null {
    if (this.phase === 'race' && !this.spectator) {
      if (this.finished) return { text: this.stage === 'results' ? 'RACE OVER' : 'FINISHED', clock: false };
      if (this.held) return { text: 'ON THE GRID', clock: false };
      return { text: `LAP ${Math.min(this.raceLaps + 1, this.net.settings.raceLaps)}/${this.net.settings.raceLaps}`, clock: true };
    }
    if (this.finished) return { text: 'SESSION OVER', clock: false };
    if (this.oneShotEntrant && !this.oneShotGo) return { text: 'IN THE PITS', clock: false };
    return null;
  }
  private get oneShotGhost() { return this.phase === 'qualifying' && this.net.session.oneShot; }
  private get oneShotEntrant() { return this.oneShotGhost && this.net.session.grid.includes(this.net.selfId); }
  // One-shot qualifying as the HUD shows it: every entrant in release order, when it goes out (relay time) and where it
  // is: waiting in the pits, out (on its run-up and lap), or done. Empty outside one-shot qualifying.
  oneShotRunners(now: number): { id: number; at: number; state: 'waiting' | 'out' | 'done' }[] {
    const s = this.net.session;
    if (!this.oneShotGhost) return [];
    const T = this.net.serverTime(now);
    return s.grid.filter((id) => id === this.net.selfId || this.net.players.has(id)).map((id) => {
      const at = oneShotRelease(s, id)!;
      if (this.oneShotDone.has(id)) return { id, at, state: 'done' as const };
      if (id === this.net.selfId) return { id, at, state: this.finished ? 'done' as const : this.oneShotGo ? 'out' as const : 'waiting' as const };
      const r = this.mpSamples.get(id)?.reason;
      // (a car released is out once it leaves the pit lane: until then, waiting for the start spot to clear)
      return { id, at, state: T < at || r === CAR_REASON.pits || r == null ? 'waiting' as const : 'out' as const };
    });
  }
  // One-shot: s until our release (0: due, waiting for the start spot to clear; null: not waiting).
  oneShotIn(now: number): number | null {
    if (!this.oneShotEntrant || this.oneShotGo || this.finished) return null;
    return Math.max(0, oneShotRelease(this.net.session, this.net.selfId)! - this.net.serverTime(now));
  }
  // The compounds our car can fit, the next one in the list (dir -1: the one before), and the set for a start.
  cycleCompound(dir = 1) {
    this.compoundChosen = true;
    const cs = this.session.car.compounds, k = cs.findIndex((c) => c.id === this.nextCompound);
    this.nextCompound = cs[((k < 0 ? 0 : k) + dir + cs.length) % cs.length].id;
    return this.nextCompound;
  }
  setStartCompound(id: CompoundId | null) { this.startCompound = id && this.session.car.compounds.some((c) => c.id === id) ? id : null; }
  // About how many laps a fresh set of `id` lasts here at the room's wear (from the F1's at Melbourne at scale 1,
  // per km: 43 / 64 / 90 laps soft / medium / hard, the rain tyres about as the medium; CarInfo.race.wearScale makes
  // each car's about the F1's). Null for a car or compound that does not wear.
  // k: the wear setting (the room's by default; the lobby screen passes the one the host is choosing).
  tyreLife(id: CompoundId = this.nextCompound, k = this.net.settings.tyreWear): number | null {
    const base: Partial<Record<CompoundId, number>> = { soft: 43, medium: 64, hard: 90, intermediate: 64, wet: 64, allweather: 60 };
    const b = base[id];
    return b == null || !(k > 0) ? null : (b * 5.278) / (this.def.lengthKm * k);
  }
  // The start compound the weather calls for (rain tyres on a wet track, else the medium for a race, soft otherwise):
  // intermediates beat slicks from a wetness of about 0.18 and wets beat intermediates from about 0.65 (README, Race
  // conditions), so the switch is just past each.
  autoCompound(): CompoundId {
    const cs = this.session.car.compounds, has = (id: CompoundId) => cs.some((c) => c.id === id);
    const want: CompoundId = this.wetness >= 0.65 ? 'wet' : this.wetness >= 0.2 ? 'intermediate' : this.net.session.phase === 'race' ? 'medium' : 'soft';
    return has(want) ? want : cs[0].id;
  }

  // ------------------------------------------------------------------------ driving
  // The player's restart key: a flying start on a fresh set of the next compound, except where a race has no start
  // spot to go back to (a race we are in, one-shot qualifying's lap): there it is a recovery.
  requestRestart() {
    if (this.held || this.pit.service > 0) return;   // (one-shot: waiting in the pits, or the lap done; a stop under way)
    if (this.recoveryOnly) this.recover(); else this.flyingStart(this.nextCompound);
  }
  private get recoveryOnly() {
    return (this.phase === 'race' && !this.spectator && this.stage !== 'results') || (this.oneShotGhost && this.oneShotGo && !this.finished);
  }
  // (a car we hold still is not stuck)
  private autoReset() {
    if (this.held || this.recovering > 0 || this.pit.service > 0 || this.parked) return;
    if (this.recoveryOnly) this.recover(); else this.flyingStart(this.nextCompound);
  }

  // Every frame (and in tests every tick), after the network's events: follow the relay's session.
  update(now: number) {
    const s = this.net.session, T = this.net.serverTime(now);
    const key = `${s.phase}:${s.index}:${s.start}`;
    this.weather(now);
    if (key !== this.key) { const first = this.key === ''; this.key = key; this.enter(s, T, first, now); }
    if (s.stage !== this.stage) this.stageChanged(s);
    this.raceStage = this.net.raceStage(now);
    this.spectator = this.net.isSpectator();
    // one-shot: our release, one car at a time (oneShotRelease), from the pit lane to the start spot once it is clear
    const at = this.oneShotEntrant ? oneShotRelease(s, this.net.selfId) : null;
    if (at != null && T >= at && !this.oneShotGo && !this.finished && (T >= at + ONE_SHOT_WAIT || this.startSpotClear())) {
      this.oneShotGo = true;
      this.flyingStart(this.nextCompound, 'lap');
      this.notify('flag', 'GO', 'Your flying lap: it starts at the line');
    }
  }

  // No other car on the track from CLEAR_BEHIND m before the start spot to CLEAR_AHEAD m after it (cars in the pit
  // lane, waiting or done, do not count).
  private startSpotClear(): boolean {
    const tr = this.session.track, L = tr.L, s0 = this.session.startS;
    for (const p of this.mpSamples.values()) {
      projectOnTrack(tr, p.x, p.z, -1, this.proj);
      if (laneZone(this.lane, tr, this.proj) !== 'track') continue;
      const d = ((this.proj.s - s0) % L + L) % L;   // m past the start spot, 0..L
      if (d <= CLEAR_AHEAD || L - d <= CLEAR_BEHIND) return false;
    }
    return true;
  }

  // One-shot: the k-th entrant's spot in the pit lane, at rest facing down the lane, through the limited stretch from
  // its start (10 m apart, closer if the stretch is short; ghosts, so a full room may overlap).
  private toPitSpot() {
    const s = this.net.session, n = Math.max(1, s.grid.length), k = Math.max(0, s.grid.indexOf(this.net.selfId));
    const L = this.lane, tr = this.session.track, room = L.limOut - L.limIn - 16;
    const d = L.limIn + 8 + (n > 1 ? k * Math.min(10, room / (n - 1)) : 0), j = Math.round(d / (tr.L / tr.N));
    this.session.placeCar((L.sStart + d) % tr.L, L.side * (L.inner[j] + L.outer[j]) / 2, 0);
    Object.assign(this.pit, { service: 0, stopped: true, inLane: true, passedBox: false });
    this.pitRequest = false;
  }

  // Events Multiplayer passes on (ours included).
  onEvent(e: NetEvent) {
    if (e.type === 'standings') this.standings();
    if (e.type === 'lap' && this.oneShotGhost && this.net.session.grid.includes(e.player)) this.oneShotDone.add(e.player);
  }

  // The input for this tick (held, recovering, parked, the pit limiter and service), before Session.tick.
  input(inp: DriveInput, tickAt: number, parked: boolean): DriveInput {
    this.parked = parked && this.keepsRunning;
    const T = this.net.serverTime(tickAt), s = this.net.session;
    const wasHeld = this.held;
    if (this.parkPending) { this.parkPending = false; this.toPitSpot(); }
    // (one-shot: an entrant waits in the pits until its release, and goes back there when its lap is done)
    this.held = this.oneShotEntrant ? !this.oneShotGo || this.finished : this.net.held(tickAt);
    if (wasHeld && !this.held && s.phase === 'race' && !this.spectator) {
      // lights out: lap 1 is timed from here (from the grid, through the first crossing, to the second)
      this.goSim = this.session.simTime + Math.max(0, Math.min(DT, (s.goAt ?? T) - (T - DT)));
      this.session.timing.startStanding(this.goSim);
      const n = this.mandatoryStops;
      this.notify('flag', 'LIGHTS OUT', n ? `${n} pit stop${n > 1 ? 's' : ''} to make: stop in your box in the pit lane` : undefined);
    }
    const car = this.session.car, v = car.speedF;
    // stopping: the brake while it rolls, then nothing (a brake held at a standstill is the automatic box's reverse)
    const stop = { throttle: 0, brake: Math.abs(v) > 0.3 ? 1 : 0, steer: 0, analog: inp.analog, steerAngle: null, autoGears: inp.autoGears };
    if (this.held || this.pit.service > 0 || this.recovering > 0 || this.parked) return stop;
    if (this.pit.inLane) {
      let vmax = laneLimit(this.lane, this.pit.dist);
      // the pit request: the limiter brings the car to a stop in the box (BOX_DECEL down to its middle)
      if (this.pitRequest && !this.pit.stopped && this.serviceAllowed) vmax = Math.min(vmax, Math.sqrt(2 * BOX_DECEL * Math.max(0, this.lane.box - this.pit.dist)));
      this.pit.limiter = vmax < Infinity && v > vmax - 2;
      if (v > vmax + 0.3) return { ...inp, throttle: 0, brake: Math.max(inp.brake, Math.min(1, Math.max(0.15, (v - vmax) / 3))) };
      if (vmax < Infinity) return { ...inp, throttle: Math.min(inp.throttle, Math.max(0, (vmax - v) / 1.5)) };
    } else this.pit.limiter = false;
    return inp;
  }

  // After Session.tick: the pit lane, service, recoveries counting down, the running order.
  afterTick(tickAt: number) {
    const car = this.session.car, tr = this.session.track, p = this.pit;
    if (this.recovering > 0) this.recovering = Math.max(0, this.recovering - DT);
    // the pit lane, with hysteresis: in once the centre is in the lane, out once it is back on the track
    p.zone = laneZone(this.lane, tr, car.proj);
    const inLane = p.zone === 'lane' || (p.inLane && p.zone === 'near');
    p.dist = laneDist(this.lane, tr, car.proj.s);
    if (inLane && !p.inLane) {
      // into the lane: a stop is wanted (the request, turned on by driving in; the key turns it off: a drive-through)
      p.stopped = false; p.passedBox = false;
      if (!this.held && !this.pitRequest) this.setPitRequest(true);
    }
    if (inLane && p.dist > this.lane.box + PIT.boxLen / 2 && p.dist < this.lane.len) p.passedBox = true;
    // out of the lane: a drive-through only if the car went past the box without stopping in a race it is still in
    // (a brush with the lane's edge, a session change or the car's finish in the lane is none)
    if (!inLane && p.inLane) {
      if (p.passedBox && !p.stopped && this.racing) this.notify('race', 'Drive-through: no stop made');
      if (p.stopped || p.passedBox) this.pitRequest = false;
    }
    p.inLane = inLane;
    if (p.service > 0) {
      p.service = Math.max(0, p.service - DT);
      if (p.service === 0) this.serviced(tickAt);
    } else if (inLane && !p.stopped && Math.abs(p.dist - this.lane.box) <= PIT.boxLen / 2 && Math.abs(car.speedF) < 0.5 && !this.held && this.serviceAllowed) {
      p.serviceTotal = p.service = car.spec.race.pitSecs;
    }
    if (this.pitHelpFor > 0) this.pitHelpFor = Math.max(0, this.pitHelpFor - DT);
    if ((this.orderWait -= DT) <= 0) { this.orderWait = ORDER_EVERY; this.updateOrder(tickAt); }
  }

  // Whether to report a lap that has just been completed (crossing: its relay time).
  shouldSend(lap: { time: number }, crossing: number): boolean {
    const s = this.net.session;
    if (this.phase === 'qualifying' && s.oneShot) {
      if (!s.grid.includes(this.net.selfId) || !this.oneShotGo || this.finished) return false;
      this.finished = true; this.parkPending = true;
      this.notify('flag', 'Lap done', 'Back in the pits: the others are still out');
      return true;
    }
    if (this.phase === 'qualifying' && s.stage === 'finishing') {
      if (this.finished) return false;
      this.finished = true;
      this.notify('flag', 'Qualifying over', 'Drive on as a ghost');
      return crossing - lap.time <= (s.finishAt ?? Infinity) + 1;
    }
    // (a race: the lap that ends it for us, whether the winner's or one after the flag; the standings confirm it)
    if (this.phase === 'race' && !this.spectator && !this.finished && (this.raceLaps + 1 >= this.net.settings.raceLaps || s.stage === 'finishing')) this.lastLapIn = true;
    return !this.finished;
  }

  // ------------------------------------------------------------------------ the pit request and its guidance
  // In a race we are still racing in (not finished, not a spectator, past the grid).
  private get racing() { return this.phase === 'race' && !this.spectator && !this.finished && !this.lastLapIn && this.stage !== 'results'; }
  // The box serves the car: not once its race is over (the relay would refuse the stop).
  private get serviceAllowed() { return this.phase !== 'race' || this.racing; }
  // The box is past the start/finish line (the lane runs across it): a stop on a lap is made after the line.
  get boxPastLine() { const L = this.session.track.L; return (this.lane.sStart + this.lane.box) % L < L / 2; }
  togglePitRequest() { return this.setPitRequest(!this.pitRequest); }
  setPitRequest(on: boolean) {
    this.pitRequest = on;
    if (on) {
      // tyres for the weather, unless the player chose the next set this session
      const want = this.autoCompound();
      if (!this.compoundChosen && this.tyresWrong() && want !== this.nextCompound) this.nextCompound = want;
      this.explainPits();
    }
    return on;
  }
  // The one-line explanation, once a weekend (until the lobby).
  explainPits() {
    if (this.pitExplained) return;
    this.pitExplained = true;
    this.pitHelpFor = PIT_HELP_SECS;
    const side = this.lane.side > 0 ? 'left' : 'right';
    this.pitHelp = `Pit stops: press the pit key to box this lap, follow the arrows into the pit lane on the ${side} before the line, `
      + `and the limiter stops you in your yellow box; new tyres go on, then drive out.`;
  }
  // The tyres fitted are wrong for the conditions: slicks on a wet track (or rain tyres on a dry one), intermediates in
  // standing water, wets on a merely damp track.
  tyresWrong(): boolean {
    const id = this.session.car.compound.id, w = this.wetness;
    if (id === 'allweather') return false;
    if (id === 'intermediate') return w < 0.1 || w > 0.8;
    if (id === 'wet') return w < 0.5;
    return w > 0.3;
  }
  // Why a stop is worth making now (the HUD suggests one; null: no reason): a mandatory stop owed with the laps
  // running out, worn tyres, or tyres wrong for the weather. Only while racing and not on the way in already.
  get pitAdvice(): string | null {
    if (!this.racing || this.held || this.pitRequest || this.pit.inLane || this.pit.service > 0) return null;
    const me = this.net.standings.find((x) => x.player === this.net.selfId);
    // laps still to go in which a stop can be made, this one too (not the last where the box is past the line)
    const owed = this.mandatoryStops - (me?.pits ?? this.pit.stops), left = this.net.settings.raceLaps - this.raceLaps - (this.boxPastLine ? 1 : 0);
    if (owed > 0 && left > 0 && left <= owed + 1) return `${owed} stop${owed > 1 ? 's' : ''} owed`;
    if (this.tyresWrong()) return this.wetness > 0.3 && !this.session.car.compound.rain ? 'Rain tyres needed' : 'Wrong tyres for the track';
    if (this.session.car.tyreWear.some((x) => x >= WORN)) return 'Tyres worn';
    return null;
  }
  // The guidance for the HUD (null: nothing to show).
  get pitGuide(): PitGuide | null {
    const p = this.pit, tr = this.session.track;
    if (this.held) return null;   // (one-shot qualifying's cars waiting in the lane, or done)
    if (p.service > 0) return { step: 'service', left: p.service, total: p.serviceTotal };
    if (p.inLane) {
      if (p.stopped) return { step: 'go' };
      if (!this.pitRequest || !this.serviceAllowed) return { step: 'through' };
      const box = this.lane.box - p.dist;
      return box < 40 ? { step: 'box', box } : { step: 'lane', box, limiter: p.limiter };
    }
    if (!this.pitRequest || this.held || this.recovering > 0) return null;
    if (p.zone !== 'track' && p.dist < this.lane.len) return { step: 'lane', box: this.lane.box - p.dist, limiter: false };   // (on the way in)
    // (alongside the entry ramp but not in the lane yet: the entry is here; past the ramp: missed, the next lap's)
    const d = p.dist < this.lane.limIn ? 0 : ((this.lane.sStart - this.session.car.proj.s) % tr.L + tr.L) % tr.L;
    return { step: 'entry', dist: d, side: this.lane.side };
  }

  // ------------------------------------------------------------------------
  private startCompoundNow(): CompoundId { return this.startCompound ?? this.autoCompound(); }

  // A new session (or the first one we see): reset what is per session and put the car where it belongs.
  private enter(s: SessionInfo, T: number, first: boolean, now: number) {
    const ses = this.session, tr = ses.track;
    this.phase = s.phase; this.index = s.index; this.stage = s.stage;
    this.finished = false; this.oneShotGo = false; this.goSim = null; this.recovering = 0; this.raceLaps = 0; this.lastPenalty = 0;
    Object.assign(this.pit, { service: 0, stops: 0, stopped: false, limiter: false, inLane: false, passedBox: false });
    this.pitRequest = false; this.compoundChosen = false; this.lastLapIn = false;
    if (s.phase === 'lobby') this.pitExplained = false;   // (once a weekend)
    this.runners.clear(); this.order = []; this.gapAhead = this.gapBehind = null;
    this.oneShotDone.clear(); this.parkPending = false;
    // (a race's best times are this race's: the timing panel's BEST is the best lap of this race, not of earlier ones)
    if (s.phase === 'race') clearStore(this.def.storeKey + ses.car.spec.storeKey + '.race');
    ses.setStoreTag(s.phase === 'race' ? '.race' : '.mp');
    ses.timing.runup = s.phase === 'race' ? 0 : this.def.startBack;
    this.spectator = this.net.isSpectator();
    this.weather(now, true);
    const c = this.startCompoundNow();
    this.nextCompound = c;
    const slot = this.net.gridSlot();
    if (first && s.phase === 'lobby') return;   // joining a room's lobby: driving on from where we are
    if (s.phase !== 'lobby' && !s.oneShot && !this.spectator) this.explainPits();   // (the weekend's first session)
    if (s.phase === 'race' && slot != null && s.goAt != null && T >= s.goAt) {
      // back in a race under way (a reload): out of our pit box, on a fresh set
      const k = Math.round(this.lane.box / (tr.L / tr.N));
      ses.car.fitTyres(c, 'blanket');
      ses.placeCar(this.lane.sStart + this.lane.box, this.lane.side * (this.lane.inner[k] + this.lane.outer[k]) / 2, 0);
      this.standings();   // (the welcome's standings: whether our race is already over)
      this.notify('flag', 'BACK IN THE RACE', 'Out of the pits');
    } else if (s.phase === 'race' && slot != null) {
      this.grid = gridSlots(tr, Math.max(this.net.maxPlayers, s.grid.length, slot + 1));
      const g = this.grid[slot];
      // the start spot first: a fresh car (full battery) as from the garage, then onto the grid on a fresh set
      ses.placeCar(ses.startS, 0, 0);
      ses.car.fitTyres(c, 'blanket');
      ses.placeCar(g.s, g.lat, 0);
      this.held = true;
      this.notify('flag', 'RACE', `${this.net.settings.raceLaps} laps · grid slot ${slot + 1}`);
    } else if (s.phase === 'qualifying' && s.oneShot && s.grid.includes(this.net.selfId)) {
      // in the pit lane, out of everyone's way, until our turn (oneShotRelease)
      ses.car.fitTyres(c, 'lap');
      this.toPitSpot();
      this.held = true;
      const k = s.grid.indexOf(this.net.selfId), at = oneShotRelease(s, this.net.selfId)!;
      this.notify('flag', 'ONE-SHOT QUALIFYING', `One flying lap each, one car at a time: you go out ${ordinal(k + 1)} of ${s.grid.length}, in ${Math.max(0, Math.round(at - T))} s`);
    } else {
      this.flyingStart(c, 'lap');
      if (s.phase === 'race') this.notify('flag', 'SPECTATING', 'The race started before you joined: drive as a ghost');
      else if (s.phase === 'practice') this.notify('flag', sessionName(s), `${this.net.settings.practiceMinutes} min`);
      else if (s.phase === 'qualifying') this.notify('flag', sessionName(s), `${this.net.settings.qualifyingMinutes} min: the best lap sets the grid`);
    }
  }

  private stageChanged(s: SessionInfo) {
    const before = this.stage;
    this.stage = s.stage;
    // (not for the winner, whose finish the standings may have told already, nor for a spectator)
    if (s.phase === 'race' && s.stage === 'finishing' && before === 'running' && !this.finished && !this.spectator) this.notify('flag', 'CHEQUERED FLAG', 'Finish this lap');
    if (s.phase === 'race' && s.stage === 'results') this.finished = true;
    if (s.phase === 'qualifying' && s.stage === 'finishing' && !s.oneShot) this.notify('flag', 'CHEQUERED FLAG', 'Finish the lap you are on: it is your last');
  }

  private standings() {
    if (this.phase !== 'race') return;
    const L = this.session.track.L;
    // the running order's distances put right by the laps counted (beyond 50 m of slack for a proxy's error at the line)
    for (const st of this.net.standings) {
      const r = this.runners.get(st.player);
      if (r && (r.dist < st.laps * L - 50 || r.dist >= (st.laps + 1) * L + 50)) r.dist = st.laps * L + (r.s < L / 2 ? r.s : r.s - L);
    }
    const me = this.net.standings.find((x) => x.player === this.net.selfId);
    if (!me) return;
    if (me.laps !== this.raceLaps) {
      this.raceLaps = me.laps;
      // (a missed stop costs a minute: say so while there is a lap to make it, which is the lap before the last where
      // the box is past the line: there the last lap's crossing in the lane is the finish)
      const total = this.net.settings.raceLaps, owed = this.mandatoryStops - me.pits, racing = this.stage === 'running' && me.status === 'racing';
      const stopText = `${owed} stop${owed > 1 ? 's' : ''} still to make`;
      if (me.laps === total - 1 && racing) this.notify('flag', 'FINAL LAP', owed > 0 && !this.boxPastLine ? `Pit this lap: ${stopText}` : undefined);
      else if (me.laps === total - 2 && racing && owed > 0 && this.boxPastLine) this.notify('flag', 'PIT THIS LAP', `${stopText}: the box is past the line, too late on the last lap`);
    }
    if (me.status !== 'racing' && !this.finished) {
      this.finished = true;
      const pos = this.net.standings.indexOf(me) + 1;
      if (me.status === 'finished') this.notify('flag', `FINISHED P${pos}`, `${fmtTime(me.time ?? 0)}${me.penalty ? ` + ${me.penalty} s` : ''}`);
    }
    if (me.penalty > this.lastPenalty) {
      if (me.status === 'racing') this.notify('flag', `+${(me.penalty - this.lastPenalty).toFixed(0)} s PENALTY`, 'Invalid lap');
      this.lastPenalty = me.penalty;
    }
  }

  // A flying start (the session's restart) on a fresh set of `id`.
  private flyingStart(id: CompoundId, heat: 'lap' | 'blanket' = 'lap') {
    const car = this.session.car;
    if (car.compounds.some((c) => c.id === id)) car.fitTyres(id, heat);
    this.session.restart();
    this.held = false; this.recovering = 0;
    Object.assign(this.pit, { service: 0, stopped: false, inLane: false, passedBox: false });
    this.pitRequest = false;
  }

  // Put back on the track where the car is (the nearest point, a lane's middle in the pit lane, else at most 2 m
  // inside the edge), stopped, and held there for RECOVERY_SECS as a ghost: the lap goes on.
  private recover() {
    const ses = this.session, tr = ses.track, car = ses.car, s = car.proj.s;
    const i = pointAt(tr, s).i, k = laneIndex(this.lane, tr, i);
    let lat: number;
    if (k >= 0 && this.pit.zone !== 'track') lat = this.lane.side * (this.lane.inner[k] + this.lane.outer[k]) / 2;
    else lat = Math.max(-(tr.WR[i] - 2), Math.min(tr.WL[i] - 2, car.proj.lat));
    ses.placeCar(s, lat, 0, true);
    this.recovering = RECOVERY_SECS;
    this.pit.service = 0;
    this.notify('flag', 'RECOVERY', `Held for ${RECOVERY_SECS} s`);
  }

  // The box's work is done: the new set, and the stop reported.
  private serviced(tickAt: number) {
    const car = this.session.car, id = this.nextCompound;
    if (car.compounds.some((c) => c.id === id)) car.fitTyres(id, 'blanket');
    else car.fitTyres(car.compound.id, 'blanket');
    this.pit.stopped = true;
    this.pit.stops++;
    this.net.sendPit({ compound: COMPOUND_CODE[car.compound.id], at: tickAt });
    this.notify('race', `Pit stop ${this.pit.serviceTotal.toFixed(1)} s: ${car.compound.name}`);
  }

  // The relay's weather into the physics (with the room's wear) and for the game to draw.
  private weather(now: number, force = false) {
    if (!force && now - this.condAt < CONDITIONS_EVERY) return;
    this.condAt = now;
    const c = this.net.conditions(now);
    this.rain = c.rain; this.wetness = c.wet;
    const car = this.session.car;
    this.session.setConditions({
      wearScale: this.net.settings.tyreWear * car.spec.race.wearScale,
      rain: Math.round(c.rain * 200) / 200, wetness: Math.round(c.wet * 200) / 200,
    });
    if (this.phase === 'lobby') return;
    const raining = c.rain > (this.wasRaining ? 0.08 : 0.15), wet = c.wet > (this.wasWet ? 0.25 : 0.4);
    if (raining && !this.wasRaining) this.notify('race', c.rain > 0.5 ? 'Heavy rain' : 'Rain starting');
    if (!wet && this.wasWet && !raining) this.notify('race', 'Track drying');
    this.wasRaining = raining; this.wasWet = wet;
  }
  private condAt = -Infinity;

  // ------------------------------------------------------------------------ the running order
  // Every car's distance since the start: its track position unwrapped from tick to tick, put right by its laps at
  // each lap report; each car's timing loops (when it passed every GAP_BUCKET m over the last lap) give the gaps.
  private updateOrder(tickAt: number) {
    if (this.phase !== 'race') { if (this.order.length) this.order = []; return; }
    const net = this.net, tr = this.session.track, T = net.serverTime(tickAt), L = tr.L;
    const standings = net.standings;
    const pos = new Map<number, { x: number; z: number; compound: number; reason: number }>();
    pos.set(net.selfId, { x: this.session.car.pos.x, z: this.session.car.pos.z, compound: COMPOUND_CODE[this.session.car.compound.id], reason: this.reason });
    for (const [id, rc] of this.mpSamples) pos.set(id, rc);
    for (const st of standings) {
      const p = pos.get(st.player);
      if (!p) continue;
      let r = this.runners.get(st.player);
      if (!r) {
        const n = Math.ceil(L / GAP_BUCKET) + 2;
        r = { dist: 0, s: 0, seen: false, hint: -1, times: new Float64Array(n).fill(Number.NaN), ids: new Int32Array(n).fill(-1), last: -1, laps: st.laps };
        this.runners.set(st.player, r);
      }
      r.hint = projectOnTrack(tr, p.x, p.z, r.hint, this.proj).i;
      const s = this.proj.s;
      if (!r.seen) { r.seen = true; r.dist = st.laps * L + (s > L / 2 ? s - L : s); }
      else { let d = s - r.s; if (d > L / 2) d -= L; if (d < -L / 2) d += L; r.dist += d; }
      r.s = s;
      // the timing loops passed since the last update
      const b = Math.floor(r.dist / GAP_BUCKET), n = r.ids.length;
      if (r.last < 0) r.last = b;
      for (let k = Math.max(r.last + 1, b - n + 1); k <= b; k++) { r.ids[((k % n) + n) % n] = k; r.times[((k % n) + n) % n] = T; }
      if (b > r.last) r.last = b;
    }
    const passed = (r: Runner, dist: number) => {
      const b = Math.floor(dist / GAP_BUCKET), n = r.ids.length, j = ((b % n) + n) % n;
      return r.ids[j] === b ? r.times[j] : null;
    };
    const live = standings.filter((st) => st.status !== 'dnf');
    const fin = live.filter((st) => st.status !== 'racing'), racing = live.filter((st) => st.status === 'racing');
    racing.sort((a, b) => (this.runners.get(b.player)?.dist ?? -Infinity) - (this.runners.get(a.player)?.dist ?? -Infinity));
    const all = [...fin, ...racing], lead = all[0] ? this.runners.get(all[0].player) : undefined;
    const reasons = pos;
    this.order = all.map((st, k) => {
      const r = this.runners.get(st.player), info = pos.get(st.player);
      const dist = r?.dist ?? st.laps * L;
      let gap: number | null = null, down = 0;
      if (k > 0 && lead && r) {
        if (st.status === 'racing') {
          const t = passed(lead, dist);
          if (t != null) gap = T - t; else down = Math.max(0, Math.floor((lead.dist - dist) / L));   // (0: the leader has not been there yet)
        } else if (fin[0] && st.laps === fin[0].laps && st.time != null && fin[0].time != null) gap = st.time + st.penalty - (fin[0].time + fin[0].penalty);
        else down = (all[0].laps - st.laps);
      }
      return { id: st.player, name: st.name, car: st.car, self: st.player === net.selfId, pos: k + 1, laps: st.laps, dist, gap, lapsDown: down,
        status: st.status, compound: info?.compound ?? 0, pits: st.pits, inPits: reasons.get(st.player)?.reason === CAR_REASON.pits, penalty: st.penalty };
    });
    const me = this.order.findIndex((e) => e.self), mr = this.runners.get(net.selfId);
    this.gapAhead = this.gapBehind = null; this.aheadId = this.behindId = 0;
    if (me >= 0 && mr) {
      const ahead = this.order[me - 1], behind = this.order[me + 1];
      if (ahead) { this.aheadId = ahead.id; const ra = this.runners.get(ahead.id), t = ra && passed(ra, mr.dist); this.gapAhead = t != null ? T - t : null; }
      if (behind) { this.behindId = behind.id; const t = passed(mr, this.runners.get(behind.id)?.dist ?? -1); this.gapBehind = t != null ? T - t : null; }
    }
  }
  // Other cars' latest positions (Multiplayer fills it each tick): id -> where, compound, reason
  readonly mpSamples = new Map<number, { x: number; z: number; compound: number; reason: number }>();
}

export function sessionName(s: Pick<SessionInfo, 'phase' | 'index' | 'oneShot'>): string {
  switch (s.phase) {
    case 'lobby': return 'Lobby';
    case 'practice': return `Practice ${s.index}`;
    case 'qualifying': return s.oneShot ? 'One-shot qualifying' : 'Qualifying';
    case 'race': return 'Race';
  }
}
