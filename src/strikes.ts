import { LIMITER_PENALTY_SECS, STRIKES_PER_PENALTY } from './net';
import type { DriveInput } from './vehicle';

// ============================================================================
// A race's track limits rule (docs/net.md, **Track limits in a race**; the room setting `trackLimits`): strikes, and
// every STRIKES_PER_PENALTY-th strike a spell of LIMITER_PENALTY_SECS on the pit limiter. Weekend owns one: it adds a
// strike for every excursion beyond the track limits (Weekend.addStrike, which other rules can use too), ticks it and
// passes the input through it. The spell starts only once the car is back within the track limits; while it runs the
// throttle is cut above the limit (the game does not brake for the driver). No DOM: the tests drive it.
// ============================================================================
type Notify = (kind: 'flag' | 'race' | 'error', text: string, sub?: string) => void;

export class Strikes {
  count = 0;                          // strikes towards the next penalty (0..STRIKES_PER_PENALTY - 1)
  pending = false;                    // a penalty earned, waiting for the car to be back within the track limits
  left = 0;                           // s of the penalty limiter still to serve (counting down)
  limiting = false;                   // this tick: the penalty limiter is cutting the throttle

  constructor(private readonly notify: Notify, readonly limitMs: number) {}

  // The penalty limiter is on (earned and started).
  get serving() { return this.left > 0; }

  // A strike (reason: what it was for, e.g. 'Track limits'); the third brings the penalty.
  add(reason: string) {
    this.count++;
    const k = this.count, n = STRIKES_PER_PENALTY;
    if (k < n) { this.notify('flag', `${reason.toUpperCase()} ${k}/${n}`, `Strike ${n}: ${LIMITER_PENALTY_SECS} s on the pit limiter`); return; }
    this.count = 0;
    this.pending = true;
    this.notify('flag', `${reason.toUpperCase()} ${n}/${n}`, `Penalty: ${LIMITER_PENALTY_SECS} s on the pit limiter once back on the track`);
  }

  // After each tick: onTrack, the car within the track limits; run, the clock may run (the car is being driven).
  tick(dt: number, onTrack: boolean, run: boolean) {
    if (this.pending && onTrack && run) {
      this.pending = false;
      this.left = LIMITER_PENALTY_SECS;
      this.notify('flag', 'LIMITER PENALTY', `${LIMITER_PENALTY_SECS} s at ${Math.round(this.limitMs * 3.6)} km/h`);
    }
    if (this.left > 0 && run) this.left = Math.max(0, this.left - dt);
    if (this.left === 0) this.limiting = false;
  }

  // The input while the penalty runs: no throttle above the limit (v: the car's forward speed, m/s).
  input(inp: DriveInput, v: number): DriveInput {
    this.limiting = this.left > 0 && Math.abs(v) > this.limitMs - 2;
    if (this.left > 0 && Math.abs(v) > this.limitMs) return { ...inp, throttle: 0 };
    return inp;
  }

  reset() { this.count = 0; this.pending = false; this.left = 0; this.limiting = false; }
}
