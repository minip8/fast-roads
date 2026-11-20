import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { autopilot, buildSpeedProfile } from '../autopilot';
import { CARS, type CarId } from '../cars';
import { DT } from '../config';
import { createVehicle, needsReset, Session, stepPhysics } from '../sim';
import { loadCircuit } from '../circuit';
import { pointAt, type Track, type TrackPos } from '../track';
import { TRACKS, type TrackId } from '../tracks';
import type { DriveInput, Vehicle } from '../vehicle';
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type EnvConfig, type StartMode } from './config';
import { clamp1, Controller, PHYSICS_HZ } from './control';
import { CAR_IDS, observationSpec, type ObsEntry } from './observation';
import { Rng } from './rng';

// ============================================================================
// The RL environment: reset/step over the game's own Session (sim.ts), the code the game and the tests run. One
// action is held for 120 / actionHz physics ticks; each tick is stepPhysics, exactly as Session.tick runs it, but
// without Session.tick's own resets (a stuck autopilot, a car on its roof): here those end the episode instead
// (terminated), so nothing moves the car behind the learner's back. The action's way to the car, and what the
// observation reads besides the car, are control.ts's Controller, which a trained policy drives the game's car
// through too (policyDriver.ts). docs/ai-env.md is the reference.
// ============================================================================

export const TRACK_IDS = Object.keys(TRACKS) as TrackId[];   // track_index in info
export { PHYSICS_HZ };

// Why an episode ended (info end_reason). 1-4 are terminations, 5-6 truncations.
export const END_REASONS = ['none', 'flipped', 'wrong_way', 'stuck', 'wall', 'time_limit', 'lap_done'] as const;
export const END = { none: 0, flipped: 1, wrongWay: 2, stuck: 3, wall: 4, timeLimit: 5, lapDone: 6 } as const;

// Per-step info, one float64 each, in this order (the worker sends them as a block per env).
export const INFO_FIELDS = [
  'reward_progress', 'reward_wall', 'reward_off_track', 'reward_smooth', 'reward_terminal',
  'progress_m',          // centreline progress this step (m), on or off the track
  'episode_progress_m',  // since the episode began
  'episode_time',        // sim seconds since the episode began
  'lap_s',               // where the car is on the lap (m from the start/finish line)
  'lat',                 // m left of the centreline
  'speed',               // forward speed (m/s)
  'off_track_time',      // s of this step with all four wheels past the track limits
  'wall_hit',            // hardest impact speed into a wall this step (m/s)
  'wall_contact',        // 1 if the car touched a wall this step
  'end_reason',          // END_REASONS index (0 while running)
  'lap_done',            // 1 if the car crossed the line to complete a timed lap this step
  'lap_time',            // that lap's time (s, the game's timing), else NaN
  'lap_valid',           // 1 valid, 0 invalid (track limits, wrong way), NaN if no lap was completed
  'sector1', 'sector2', 'sector3',   // that lap's sector times (s), else NaN
  'laps',                // timed laps completed this episode
  'lap_valid_now',       // the lap under way is still valid (1/0), NaN before the car first crosses the line
  'autopilot_steer', 'autopilot_pedal',   // the autopilot drove this step: its last tick as an absolute action, else NaN
  'track_index', 'car_index',          // into TRACK_IDS and CAR_IDS
  'episode',             // episodes begun by this environment (1 for the first)
] as const;
export const INFO = Object.fromEntries(INFO_FIELDS.map((f, i) => [f, i])) as { [K in (typeof INFO_FIELDS)[number]]: number };

export interface ResetOptions {
  seed?: number;                 // reseed this environment's random numbers first
  track?: TrackId; car?: CarId;  // instead of drawing from the config's lists
  start?: StartMode;
  eval?: boolean;                // flying start, ends (truncated, lap_done) when the first timed lap is complete
  // pose for a random start (each instead of the drawn value)
  s?: number; lat?: number; heading?: number; speed?: number;
}

// ---- circuits, built once per process
const tracks = new Map<TrackId, Track>();
export async function loadTracks(ids: readonly TrackId[]) {
  for (const id of ids) {
    if (!TRACKS[id]) throw new Error(`unknown track ${id}`);
    if (!tracks.has(id)) tracks.set(id, await loadCircuit(TRACKS[id]));
  }
}
export function getTrack(id: TrackId): Track {
  const t = tracks.get(id);
  if (!t) throw new Error(`track ${id} is not loaded (loadTracks)`);
  return t;
}
export function speedProfile(tr: Track, car: CarId): Float64Array {
  const profs = tr.speedProfiles || (tr.speedProfiles = {});
  return profs[car] || (profs[car] = buildSpeedProfile(tr, CARS[car]));
}

export function validateConfig(cfg: EnvConfig) {
  const tpa = PHYSICS_HZ / cfg.actionHz;
  if (!(Number.isInteger(tpa) && tpa >= 1)) throw new Error(`actionHz must divide ${PHYSICS_HZ}`);
  if (!cfg.reset.tracks.length || !cfg.reset.cars.length) throw new Error('reset.tracks and reset.cars must not be empty');
  for (const t of cfg.reset.tracks) if (!TRACKS[t]) throw new Error(`unknown track ${t}`);
  for (const c of cfg.reset.cars) if (!CARS[c]) throw new Error(`unknown car ${c}`);
  if (!['absolute', 'delta'].includes(cfg.actionMode)) throw new Error(`unknown actionMode ${cfg.actionMode}`);
  if (!['random', 'flying'].includes(cfg.reset.start)) throw new Error(`unknown reset.start ${cfg.reset.start}`);
  if (!(cfg.obs.lookahead >= 1)) throw new Error('obs.lookahead must be at least 1');
  if (!(cfg.cacheSessions >= 1)) throw new Error('cacheSessions must be at least 1');
}

export interface StepResult { reward: number; terminated: boolean; truncated: boolean }

export class RaceEnv {
  readonly cfg: EnvConfig;
  readonly spec: ObsEntry[];
  readonly ticksPerAction: number;
  obs: Float32Array;                  // the latest observation (may be a view into a batch buffer: VecEnv)
  info: Float64Array;                 // the latest step's info (INFO_FIELDS)
  readonly result: StepResult = { reward: 0, terminated: false, truncated: false };
  private readonly rng: Rng;
  private readonly scene = new THREE.Scene();       // never rendered: the cars' meshes are built but not drawn
  private readonly sessions = new Map<TrackId, Session>();
  private readonly control: Controller;
  session!: Session;
  track!: Track; trackId!: TrackId; carId!: CarId;
  episode = 0;
  // episode state
  private t = 0; private limit = 0; private evalMode = false;
  private progress = 0; private maxProgress = 0; private stuck = 0; private laps = 0;
  private lastS = 0;
  private done = true;

  // RAPIER.init() must have resolved and the config's tracks be loaded (RaceEnv.create does both).
  constructor(config?: DeepPartial<EnvConfig>, seed = 0, obs?: Float32Array, info?: Float64Array) {
    this.cfg = mergeConfig(DEFAULT_CONFIG, config);
    validateConfig(this.cfg);
    this.spec = observationSpec(this.cfg.obs);
    this.control = new Controller(this.cfg);
    this.ticksPerAction = this.control.ticksPerAction;
    this.obs = obs ?? new Float32Array(this.spec.length);
    this.info = info ?? new Float64Array(INFO_FIELDS.length);
    if (this.obs.length !== this.spec.length || this.info.length !== INFO_FIELDS.length) throw new Error('obs/info buffer size');
    this.rng = new Rng(seed);
  }

  static async create(config?: DeepPartial<EnvConfig>, seed = 0): Promise<RaceEnv> {
    await RAPIER.init();
    const cfg = mergeConfig(DEFAULT_CONFIG, config);
    await loadTracks(cfg.reset.tracks);
    return new RaceEnv(config, seed);
  }

  get car(): Vehicle { return this.session.car; }
  get proj(): Readonly<TrackPos> { return this.control.proj; }   // the car on the track after the last tick
  get simTime() { return this.t; }

  // A new episode: a fresh car (a new engine instance: full battery and fuel, tyres and brakes at their start
  // temperatures, no lap energy used) on the chosen or drawn circuit, at the flying start or a random pose; lap
  // timing and every controller state cleared. writeInfo: fill `info` for the new episode (a vector env's auto-reset
  // leaves the finished episode's last info there).
  reset(opts: ResetOptions = {}, writeInfo = true): Float32Array {
    const cfg = this.cfg, rc = cfg.reset, rng = this.rng;
    if (opts.seed !== undefined) rng.seed(opts.seed);
    // every draw is made whatever the options say, so the stream stays in step
    const drawTrack = rng.pick(rc.tracks), drawCar = rng.pick(rc.cars), flyDraw = rng.next();
    const sDraw = rng.next(), latDraw = rng.next(), headDraw = rng.next(), speedDraw = rng.next();
    const trackId = opts.track ?? drawTrack, carId = opts.car ?? drawCar;
    if (!TRACKS[trackId]) throw new Error(`unknown track ${trackId}`);
    if (!CARS[carId]) throw new Error(`unknown car ${carId}`);
    const def = TRACKS[trackId], spec = CARS[carId];
    const tr = getTrack(trackId);
    this.evalMode = opts.eval ?? rc.eval;
    const flying = this.evalMode || (opts.start ?? rc.start) === 'flying' || flyDraw < rc.flyingProb;

    // A session (physics world with the circuit's walls, about 10 MB) per circuit, the most recently used
    // cacheSessions of them kept
    let sess = this.sessions.get(trackId);
    if (sess) this.sessions.delete(trackId);
    else {
      sess = new Session(tr, this.scene, spec, def);
      for (const [id, old] of this.sessions) {
        if (this.sessions.size < cfg.cacheSessions) break;
        old.car.destroy(); old.world.free(); this.sessions.delete(id);
      }
    }
    this.sessions.set(trackId, sess);   // most recent last
    this.session = sess; this.track = tr; this.trackId = trackId; this.carId = carId;
    sess.car.destroy();
    const car = createVehicle(sess.world, tr, this.scene, spec);
    sess.car = car;
    car.tc = cfg.tc; car.manual = false; car.assist = false;

    if (flying) car.placeAt(tr.L - def.startBack, 0, def.flying[carId] / 3.6);
    else {
      const s = opts.s ?? sDraw * tr.L, i = pointAt(tr, s).i;
      const m = rc.latMarginM, lo = -Math.max(0, tr.WR[i] - m), hi = Math.max(0, tr.WL[i] - m);
      const lat = opts.lat ?? (lo + (hi - lo) * latDraw) * rc.latFrac;
      const heading = opts.heading ?? (2 * headDraw - 1) * rc.headingMax;
      const speed = opts.speed ?? (rc.speedFrac[0] + (rc.speedFrac[1] - rc.speedFrac[0]) * speedDraw) * speedProfile(tr, carId)[i];
      car.placeAt(s, lat, speed, heading);
    }
    this.control.reset(car, tr);
    sess.simTime = 0;
    sess.timing.useStore(def.storeKey + spec.storeKey);
    sess.timing.reset();
    sess.timing.events.length = 0;

    this.lastS = this.control.proj.s;
    this.t = 0; this.limit = this.evalMode ? cfg.evalSecs : cfg.episodeSecs;
    this.progress = this.maxProgress = 0; this.stuck = 0; this.laps = 0;
    this.done = false;
    this.episode++;
    if (writeInfo) {
      this.info.fill(0);
      for (const f of ['lap_time', 'lap_valid', 'sector1', 'sector2', 'sector3', 'lap_valid_now', 'autopilot_steer', 'autopilot_pedal'] as const) this.info[INFO[f]] = Number.NaN;
      this.writeState();
    }
    this.observe();
    return this.obs;
  }

  // One policy step: steer and pedal in [-1, 1] (+ steer = left, + pedal = throttle, - = brake). In delta mode they
  // are changes to the command (x deltaScale). NaN in either: the autopilot drives this step instead (its
  // action-equivalent is reported in info).
  step(steer: number, pedal: number): StepResult {
    if (Number.isNaN(steer) || Number.isNaN(pedal)) return this.drive(autopilot);
    if (this.done) throw new Error('step after the episode ended: reset first');
    const rc = this.cfg.reward, c = this.control.ctl, a = clamp1(steer), b = clamp1(pedal);
    const smooth = rc.steerSmooth * (a - c.prevSteer) ** 2 + rc.pedalSmooth * (b - c.prevPedal) ** 2;
    this.control.act(a, b);
    return this.run(() => this.control.input(), smooth, false);
  }

  // One step with a driver giving the game's DriveInput every tick (the autopilot, or a test's driver): the input
  // reaches the car as it would in the game, with none of the environment's action shaping. The commands the
  // observation reports follow the driver, so a policy can take over smoothly.
  drive(driver: (car: Vehicle, track: Track) => DriveInput): StepResult {
    if (this.done) throw new Error('step after the episode ended: reset first');
    return this.run(() => this.control.follow(driver(this.car, this.track)), 0, true);
  }

  private run(input: () => DriveInput, smooth: number, autopiloted: boolean): StepResult {
    const cfg = this.cfg, tc = cfg.termination, sess = this.session, tr = this.track, L = tr.L, info = this.info;
    const control = this.control, p = control.proj, walls = control.walls;
    let credited = 0, raw = 0, offTicks = 0, end: number = END.none;
    control.beginStep();
    info[INFO.lap_done] = 0;
    for (const f of ['lap_time', 'lap_valid', 'sector1', 'sector2', 'sector3'] as const) info[INFO[f]] = Number.NaN;
    for (let k = 0; k < this.ticksPerAction && end === END.none; k++) {
      const car = sess.car;
      control.beforeTick(car);
      stepPhysics(sess.world, car, sess.timing, input(), sess.simTime);
      control.afterTick(car, tr);   // (wall contact, and where the car is now: p)
      sess.simTime += DT;
      this.t += DT;
      // centreline progress this tick, no more than the car can have moved (a projection that jumps to another
      // part of the track is not progress), and none while all four wheels are off (no gain from a cut)
      let ds = p.s - this.lastS;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      const lim = car.vel.length() * DT * 1.5 + 0.05;
      ds = ds > lim ? lim : ds < -lim ? -lim : ds;
      this.lastS = p.s;
      const W = car.wheels, off = W[0].out && W[1].out && W[2].out && W[3].out;
      raw += ds;
      if (off) offTicks++; else credited += ds;
      this.progress += ds;
      if (this.progress > this.maxProgress) this.maxProgress = this.progress;
      const ev = sess.timing.events;
      for (const e of ev) if (e.type === 'lap') {
        this.laps++;
        info[INFO.lap_done] = 1; info[INFO.lap_time] = e.lap.time; info[INFO.lap_valid] = e.lap.valid ? 1 : 0;
        for (let q = 0; q < 3; q++) info[INFO.sector1 + q] = e.lap.sectors[q] ?? Number.NaN;
      }
      ev.length = 0;
      this.stuck = Math.abs(car.speedF) < tc.stuckSpeed ? this.stuck + DT : 0;
      if (needsReset(car)) end = END.flipped;
      else if (tc.wallImpactMs > 0 && walls.hit >= tc.wallImpactMs) end = END.wall;
      else if (tc.wrongWayM > 0 && this.maxProgress - this.progress > tc.wrongWayM) end = END.wrongWay;
      else if (tc.stuckSecs > 0 && this.stuck >= tc.stuckSecs - 1e-9) end = END.stuck;
      else if (this.evalMode && info[INFO.lap_done]) end = END.lapDone;
      else if (this.t >= this.limit - 1e-9) end = END.timeLimit;
    }
    const rc = cfg.reward, r = this.result, contact = control.contact, hit = control.hit;
    r.terminated = end >= END.flipped && end <= END.wall;
    r.truncated = end === END.timeLimit || end === END.lapDone;
    this.done = r.terminated || r.truncated;
    const rp = rc.progress * credited, rw = -(rc.wallHit * hit + rc.wallContact * (contact ? 1 : 0));
    const ro = -rc.offTrack * offTicks * DT, rs = -smooth, rt = r.terminated ? -rc.terminal : 0;
    r.reward = rp + rw + ro + rs + rt;
    info[INFO.reward_progress] = rp; info[INFO.reward_wall] = rw; info[INFO.reward_off_track] = ro;
    info[INFO.reward_smooth] = rs; info[INFO.reward_terminal] = rt;
    info[INFO.progress_m] = raw;
    info[INFO.off_track_time] = offTicks * DT;
    info[INFO.wall_hit] = hit; info[INFO.wall_contact] = contact ? 1 : 0;
    info[INFO.end_reason] = end;
    info[INFO.autopilot_steer] = autopiloted ? control.ctl.cmdSteer : Number.NaN;
    info[INFO.autopilot_pedal] = autopiloted ? control.ctl.cmdPedal : Number.NaN;
    this.writeState();
    control.endStep();
    this.observe();
    return r;
  }

  private writeState() {
    const info = this.info, car = this.car, tm = this.session.timing;
    info[INFO.episode_progress_m] = this.progress;
    info[INFO.episode_time] = this.t;
    info[INFO.lap_s] = this.control.proj.s; info[INFO.lat] = this.control.proj.lat;
    info[INFO.speed] = car.speedF;
    info[INFO.laps] = this.laps;
    info[INFO.lap_valid_now] = tm.lapStart == null ? Number.NaN : tm.valid ? 1 : 0;
    info[INFO.track_index] = TRACK_IDS.indexOf(this.trackId);
    info[INFO.car_index] = CAR_IDS.indexOf(this.carId);
    info[INFO.episode] = this.episode;
  }

  private observe() {
    const n = this.control.observe(this.obs, this.car, this.track);
    if (n !== this.spec.length) throw new Error(`observation wrote ${n} values, spec has ${this.spec.length}`);
  }

  // Frees the physics worlds.
  dispose() {
    for (const s of this.sessions.values()) { s.car.destroy(); s.world.free(); }
    this.sessions.clear();
  }
}
