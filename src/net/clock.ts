// ============================================================================
// The client's estimate of the relay clock from ping/pong (NTP-style). Each pong gives one sample: the round trip
// rtt = t3 - t0 (local send and receive times) and the offset serverTime - (t0 + t3) / 2, which is exact when the
// two directions take equally long (an asymmetric link biases it by half the difference: no estimate can see that).
//
// The offset comes from the sample with the lowest round trip among the last WINDOW: queueing and jitter only ever
// add delay, so the quickest exchange is the least distorted. rtt and jitter are smoothed as TCP's (RFC 6298:
// srtt with gain 1/8, rttvar with gain 1/4: jitter is that mean deviation). The offset in use moves towards the
// estimate at no more than SLEW of elapsed time (so serverTime() never runs backwards and a car never visibly
// jumps), except that it snaps when it is more than SNAP off (the first samples, a relay restart).
// All times in seconds; `now` is the caller's local monotonic clock (performance.now() / 1000).
// ============================================================================
export const CLOCK_WINDOW = 16;
const SLEW = 0.05, SNAP = 0.25;

export class ClockSync {
  offset = 0;                      // relay time - local time, as used
  target = 0;                      // the current best estimate
  rtt = 0;                         // smoothed round trip (s)
  jitter = 0;                      // smoothed mean deviation of the round trip (s)
  minRtt = Infinity;               // the lowest round trip in the window
  samples = 0;                     // pongs taken
  private window: { rtt: number; offset: number }[] = [];
  private last = -Infinity;        // local time offset was last advanced to

  get synced() { return this.samples > 0; }

  // A rough first estimate before any pong (the welcome carries the relay time; sent = when the hello went).
  seed(serverTime: number, sent: number, received: number) {
    if (this.samples > 0) return;
    this.offset = this.target = serverTime - (sent + received) / 2;
    this.rtt = received - sent; this.last = received;
  }

  // One pong: sent = local time the ping left (echoed back), received = local time the pong arrived.
  sample(serverTime: number, sent: number, received: number) {
    const rtt = received - sent;
    if (!(rtt >= 0) || !Number.isFinite(serverTime)) return;
    const offset = serverTime - (sent + received) / 2;
    this.window.push({ rtt, offset });
    if (this.window.length > CLOCK_WINDOW) this.window.shift();
    let best = this.window[0];
    for (const s of this.window) if (s.rtt <= best.rtt + 1e-4) best = s;   // ties (within 0.1 ms): the newest, which follows drift
    this.minRtt = best.rtt;
    this.advance(received);
    this.target = best.offset;
    if (this.samples === 0) { this.rtt = rtt; this.jitter = rtt / 2; } else {
      this.jitter += 0.25 * (Math.abs(rtt - this.rtt) - this.jitter);
      this.rtt += 0.125 * (rtt - this.rtt);
    }
    this.samples++;
    if (this.samples === 1 || Math.abs(this.target - this.offset) > SNAP) this.offset = this.target;
  }

  // The relay clock now (s). Monotonic as long as `now` is.
  serverTime(now: number): number {
    this.advance(now);
    return now + this.offset;
  }

  private advance(now: number) {
    const dt = now - this.last;
    if (!(dt > 0)) return;
    this.last = now;
    if (!Number.isFinite(dt)) return;
    const step = SLEW * dt, d = this.target - this.offset;
    this.offset += Math.max(-step, Math.min(step, d));
  }
}
