import { DT } from '../config';
import { projectOnTrack, type Track, type TrackPos } from '../track';
import type { DriveInput, Vehicle } from '../vehicle';
import type { EnvConfig } from './config';
import { observe, steerLockOf, type ObsControl } from './observation';
import { WallSensor } from './walls';

// ============================================================================
// The policy's side of the car: how an action becomes the car's DriveInput tick by tick (targets, slew limits,
// steering as a share of the car's lock, automatic gears), and what the observation reads besides the car (ObsControl,
// the wall contact of the last step, the car's place on the track). RaceEnv (training) and PolicyDriver (a trained
// policy in the game) both drive through a Controller, so a policy meets in the game exactly the control it was
// trained with. No Node or DOM APIs.
// ============================================================================
export const PHYSICS_HZ = Math.round(1 / DT);

// The part of the environment's config that shapes the control and the observation (a trained policy file carries it).
export type ControlConfig = Pick<EnvConfig, 'actionHz' | 'actionMode' | 'deltaScale' | 'steerRate' | 'pedalRate' | 'obs'>;

export const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);
const approach = (v: number, to: number, d: number) => (v < to ? Math.min(to, v + d) : Math.max(to, v - d));

export class Controller {
  readonly ticksPerAction: number;
  readonly ctl: ObsControl = { steerLock: 1, targetSteer: 0, targetPedal: 0, cmdSteer: 0, cmdPedal: 0, prevSteer: 0, prevPedal: 0, wallContact: false, wallHit: 0 };
  readonly proj: TrackPos = { i: -1, s: 0, lat: 0 };   // the car on the track after the last tick
  readonly walls = new WallSensor();                   // this tick's wall contact
  contact = false; hit = 0;                            // the step's so far (wall contact, hardest hit m/s)
  private readonly inp: DriveInput = { throttle: 0, brake: 0, steer: 0, analog: true, steerAngle: 0, autoGears: true };
  private readonly sRate: number; private readonly pRate: number;

  constructor(readonly cfg: ControlConfig) {
    this.ticksPerAction = PHYSICS_HZ / cfg.actionHz;
    if (!(Number.isInteger(this.ticksPerAction) && this.ticksPerAction >= 1)) throw new Error(`actionHz must divide ${PHYSICS_HZ}`);
    if (!['absolute', 'delta'].includes(cfg.actionMode)) throw new Error(`unknown actionMode ${cfg.actionMode}`);
    this.sRate = cfg.steerRate * DT; this.pRate = cfg.pedalRate * DT;
  }

  // A new car, or the car placed somewhere: every command zeroed, the wall sensor on its (new) engine, the car
  // projected onto the track from scratch.
  reset(car: Vehicle, tr: Track) {
    this.walls.attach(car);
    this.proj.i = -1;
    projectOnTrack(tr, car.pos.x, car.pos.z, -1, this.proj);
    const c = this.ctl;
    c.steerLock = steerLockOf(car.spec);
    c.targetSteer = c.cmdSteer = c.prevSteer = 0;
    c.targetPedal = c.cmdPedal = c.prevPedal = 0;
    c.wallContact = false; c.wallHit = 0;
    this.contact = false; this.hit = 0;
  }

  // A policy action (steer, pedal in [-1, 1], clipped) for the step about to run: the targets the commands slew to
  // (delta mode: changes to them).
  act(steer: number, pedal: number) {
    const cfg = this.cfg, c = this.ctl, a = clamp1(steer), b = clamp1(pedal);
    if (cfg.actionMode === 'delta') {
      c.targetSteer = clamp1(c.targetSteer + a * cfg.deltaScale[0]);
      c.targetPedal = clamp1(c.targetPedal + b * cfg.deltaScale[1]);
    } else { c.targetSteer = a; c.targetPedal = b; }
    c.prevSteer = a; c.prevPedal = b;
  }

  // A step begins (whoever drives it): its wall contact starts afresh.
  beginStep() { this.contact = false; this.hit = 0; }

  // The input for the next tick: the commands slewed towards the targets, steering as a road-wheel angle.
  input(): DriveInput {
    const c = this.ctl, inp = this.inp;
    c.cmdSteer = approach(c.cmdSteer, c.targetSteer, this.sRate);
    c.cmdPedal = this.pRate > 0 ? approach(c.cmdPedal, c.targetPedal, this.pRate) : c.targetPedal;
    inp.steer = 0; inp.analog = true; inp.autoGears = true;
    inp.steerAngle = c.cmdSteer * c.steerLock;
    inp.throttle = Math.max(0, c.cmdPedal); inp.brake = Math.max(0, -c.cmdPedal);
    return inp;
  }

  // Another driver's input for the next tick (the autopilot's), passed on as it is; the commands follow it, so a
  // policy can take over smoothly.
  follow(inp: DriveInput): DriveInput {
    const c = this.ctl;
    const st = inp.steerAngle != null ? clamp1(inp.steerAngle / c.steerLock) : clamp1(inp.steer);
    c.targetSteer = c.cmdSteer = c.prevSteer = st;
    c.targetPedal = c.cmdPedal = c.prevPedal = clamp1(inp.throttle - inp.brake);
    return inp;
  }

  // Around each physics tick (stepPhysics): the wall sensor, then where the car is now (the last place as the hint).
  beforeTick(car: Vehicle) { this.walls.beforeTick(car); }
  afterTick(car: Vehicle, tr: Track) {
    const w = this.walls;
    w.afterTick(car);
    this.contact ||= w.contact;
    if (w.hit > this.hit) this.hit = w.hit;
    projectOnTrack(tr, car.pos.x, car.pos.z, this.proj.i, this.proj);
  }

  // The step is over: its wall contact is what the next observation reports.
  endStep() { this.ctl.wallContact = this.contact; this.ctl.wallHit = this.hit; }

  // The observation now, into `out`; returns how many elements were written.
  observe(out: Float32Array, car: Vehicle, tr: Track): number {
    return observe(out, car, tr, this.proj, this.ctl, this.cfg.obs);
  }
}
