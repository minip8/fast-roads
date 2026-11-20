import { DT } from '../config';
import type { Track } from '../track';
import type { DriveInput, Vehicle } from '../vehicle';
import { Controller } from './control';
import type { Policy } from './policy';

export { loadPolicyFor } from './policy';   // (main.ts imports this module alone)

// ============================================================================
// A trained policy driving the game's car: the DriveInput for every physics tick, exactly as the RL environment would
// give it (RaceEnv.step through the same Controller): every ticksPerAction ticks the car is observed and the policy
// asked, and each tick the commands slew towards its action. main.ts loads this module only for ?autopilot=rl (a
// dynamic import), so the game's own bundle does not carry it.
//   Call input() once before each tick and only then (Session.tick after it): the wall sensor and the projection
// finish the previous tick at the next call. The state starts afresh whenever the car was put somewhere (a restart,
// Session.resets moving on), replaced (another car: a different object) or a tick went by without input() (the
// autopilot or the player drove it: simTime is not one tick on), and on reset().
// ============================================================================
export interface PolicyCarSource {
  readonly car: Vehicle;          // read at every call: the game replaces the car object
  readonly resets: number;        // Session.resets
  readonly simTime: number;
  readonly track: Track;
}

export class PolicyDriver {
  readonly control: Controller;
  readonly obs: Float32Array;            // the last observation the policy saw
  readonly action = new Float32Array(2); // and its answer
  steps = 0;                             // policy steps since the state started afresh
  private k = 0;                         // ticks into the current action
  private car: Vehicle | null = null;
  private resets = -1; private time = Number.NaN;

  constructor(readonly policy: Policy, readonly source: PolicyCarSource) {
    this.control = new Controller(policy.env);
    this.obs = new Float32Array(policy.obsDim);
  }

  // Forget the state: the next input() observes the car as an episode's first step.
  reset() { this.car = null; }

  input(): DriveInput {
    const src = this.source, car = src.car, tr = src.track, c = this.control;
    if (car !== this.car || src.resets !== this.resets || src.simTime !== this.time) {
      this.car = car; this.resets = src.resets;
      c.reset(car, tr);
      this.k = 0; this.steps = 0;
    } else c.afterTick(car, tr);   // the tick since the last call
    if (this.k === 0) {
      if (this.steps > 0) c.endStep();
      const n = c.observe(this.obs, car, tr);
      if (n !== this.obs.length) throw new Error(`observation wrote ${n} values, the policy has ${this.obs.length}`);
      this.policy.run(this.obs, this.action);
      c.act(this.action[0], this.action[1]);
      c.beginStep();
      this.steps++;
    }
    if (++this.k === c.ticksPerAction) this.k = 0;
    c.beforeTick(car);
    this.time = src.simTime + DT;   // (as Session.tick moves it on)
    return c.input();
  }
}
