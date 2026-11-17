import { describe, expect, it } from 'vitest';
import { LoopbackNet } from '../src/net/loopback';
import { type CarState, decodeMessage, emptyCarState, encodeState, STATE_FLAG, unwrapTime } from '../src/net/protocol';
import { emptySample, RemoteCar, type RemoteOptions } from '../src/net/remote';

// The remote car buffer (src/net/remote.ts) against a known trajectory: a car lapping a made-up circuit at racing
// speed (50-90 m/s: full-throttle straights, 4 g braking, a 3 g hairpin, a fast sweeper, a chicane), its states
// sent at 40 Hz through the emulated link (encoded and decoded, so quantised), shown at the present on the
// receiver, 120 times a second, and compared with where the car really is. Perfect clocks: the clock's own error
// (net-clock.test.ts) adds to these. NET_REPORT=1 prints the table.

// segments: seconds, longitudinal acceleration (m/s^2), curvature (1/m, + = left); eased in over EASE s
const SEGMENTS: [number, number, number][] = [
  [3, 5, 0], [1, -40, 0], [3, 0, 1 / 80], [2, 10, 1 / 160], [4, 0, 1 / 300], [1, -20, 0],
  [2, 0, 1 / 100], [2, 0, -1 / 100], [3, 8, 0], [2, 0, -1 / 250],
];
const EASE = 0.15, V0 = 75, H = 1 / 1000;

interface Truth { t: Float64Array; x: Float64Array; z: Float64Array; h: Float64Array; v: Float64Array; w: Float64Array; a: Float64Array }
function trajectory(): Truth {
  const total = SEGMENTS.reduce((s, g) => s + g[0], 0), n = Math.ceil(total / H) + 1;
  const T: Truth = { t: new Float64Array(n), x: new Float64Array(n), z: new Float64Array(n), h: new Float64Array(n), v: new Float64Array(n), w: new Float64Array(n), a: new Float64Array(n) };
  let x = 0, z = 0, h = 0, v = V0, a = 0, k = 0, seg = 0, segEnd = SEGMENTS[0][0];
  for (let i = 0; i < n; i++) {
    const t = i * H;
    while (seg < SEGMENTS.length - 1 && t >= segEnd) segEnd += SEGMENTS[++seg][0];
    a += (SEGMENTS[seg][1] - a) * (H / EASE); k += (SEGMENTS[seg][2] - k) * (H / EASE);
    T.t[i] = t; T.x[i] = x; T.z[i] = z; T.h[i] = h; T.v[i] = v; T.w[i] = v * k; T.a[i] = a;
    // forward is +z rotated about +y by h: (sin h, 0, cos h)
    x += v * Math.sin(h) * H; z += v * Math.cos(h) * H; h += v * k * H; v += a * H;
  }
  return T;
}
const TRUTH = trajectory();
const DURATION = TRUTH.t[TRUTH.t.length - 1];

function truthState(i: number): CarState {
  const T = TRUTH, h = T.h[i], v = T.v[i];
  return { ...emptyCarState(), x: T.x[i], y: 0.3, z: T.z[i], qx: 0, qy: Math.sin(h / 2), qz: 0, qw: Math.cos(h / 2),
    vx: v * Math.sin(h), vy: 0, vz: v * Math.cos(h), wy: T.w[i], gear: 6, rpm: 10000, throttle: 1 };
}

interface Result { mean: number; p95: number; max: number; yawP95: number; collidable: number; jump: number }
function measure(latency: number, jitter: number, loss: number, opt: Partial<RemoteOptions> = {}, smooth = true, sendHz = 40, seed = 11): Result {
  const net = new LoopbackNet(seed);
  const cond = { latency, jitter, loss, duplicate: 0.01 };
  const { client: sender, server: receiver } = net.pair(cond, cond);
  net.advance(latency);
  const car = new RemoteCar(opt), out = emptySample();
  let now = 0;
  receiver.onMessage = (data) => {
    const d = decodeMessage(data);
    if (!d.ok || d.msg.type !== 'state') throw new Error('bad state');
    car.push({ ...d.msg, time: unwrapTime(d.msg.timeWire, now) }, now);
  };
  const errs: number[] = [], yaws: number[] = [];
  let seq = 0, collidable = 0, samples = 0, jump = 0, ex = NaN, ez = NaN;
  const ticks = Math.floor((DURATION - 0.5) * 120);
  for (let j = 0; j <= ticks; j++) {
    const t = j / 120;
    if (j % Math.round(120 / sendHz) === 0) {
      sender.send('unreliable', encodeState(truthState(Math.round(t / H)), ++seq, t));
    }
    now = t;
    net.advance(t);   // deliveries due by this tick are taken in it, as the game's update() would
    if (t < 1 || !car.sample(t, out, smooth)) continue;
    const i = Math.round(t / H);
    samples++;
    if (out.collidable) collidable++;
    errs.push(Math.hypot(out.x - TRUTH.x[i], out.z - TRUTH.z[i]));
    // a visible jump: how much the error changed from one frame to the next
    if (!Number.isNaN(ex)) jump = Math.max(jump, Math.hypot(out.x - TRUTH.x[i] - ex, out.z - TRUTH.z[i] - ez));
    ex = out.x - TRUTH.x[i]; ez = out.z - TRUTH.z[i];
    const yaw = 2 * Math.atan2(out.qy, out.qw);
    yaws.push(Math.abs(Math.atan2(Math.sin(yaw - TRUTH.h[i]), Math.cos(yaw - TRUTH.h[i]))) * 180 / Math.PI);
  }
  const sorted = errs.slice().sort((a, b) => a - b), ys = yaws.slice().sort((a, b) => a - b);
  return { mean: errs.reduce((a, b) => a + b, 0) / errs.length, p95: sorted[Math.floor(0.95 * sorted.length)], max: sorted[sorted.length - 1],
    yawP95: ys[Math.floor(0.95 * ys.length)], collidable: collidable / samples, jump };
}

const LINKS: [latency: number, jitter: number][] = [[0.05, 0.02], [0.1, 0.03], [0.2, 0.05]];
const fmt = (r: Result) => `mean ${r.mean.toFixed(3)} m, p95 ${r.p95.toFixed(3)} m, max ${r.max.toFixed(3)} m, yaw p95 ${r.yawP95.toFixed(2)} deg, collidable ${(100 * r.collidable).toFixed(1)}%, biggest jump ${r.jump.toFixed(3)} m`;

describe('remote car buffer', () => {
  it('follows a car at racing speed through 50/100/200 ms of latency with jitter and 5% loss', () => {
    const rows: string[] = [];
    const res = LINKS.map(([lat, jit]) => {
      const r = measure(lat, jit, 0.05);
      rows.push(`${lat * 1000} ms +0-${jit * 1000} ms, 5% loss: ${fmt(r)}`);
      rows.push(`   constant speed: ${fmt(measure(lat, jit, 0.05, { accel: false }))}`);
      rows.push(`   no smoothing:   ${fmt(measure(lat, jit, 0.05, {}, false))}`);
      rows.push(`   cap 250 ms:     ${fmt(measure(lat, jit, 0.05, { maxExtrapolate: 0.25, collideAge: 0.3 }))}`);
      return r;
    });
    if (process.env.NET_REPORT) console.log(rows.join('\n'));
    // bounds a little above what was measured (docs/net.md has the table)
    expect(res[0].p95).toBeLessThan(0.05); expect(res[0].max).toBeLessThan(0.12);
    expect(res[1].p95).toBeLessThan(0.1); expect(res[1].max).toBeLessThan(0.25);
    expect(res[2].p95).toBeLessThan(0.4); expect(res[2].max).toBeLessThan(0.9);
    for (const r of res) expect(r.jump).toBeLessThan(0.15);   // no visible snaps
    for (const r of res) expect(r.collidable).toBeGreaterThan(0.95);
  });

  it('holds a car that stopped sending, marks it not collidable, and fades it', () => {
    const car = new RemoteCar(), out = emptySample();
    const s = { ...truthState(0), seq: 1, time: 10 };
    car.push(s, 10.05);
    expect(car.sample(10.1, out)!.collidable).toBe(true);
    const at = (t: number) => { car.sample(t, out); return { z: out.z, collidable: out.collidable, alpha: out.alpha }; };
    expect(at(10.25).z).toBeCloseTo(V0 * 0.25, 1);
    expect(at(11).z).toBeCloseTo(V0 * 0.35, 1);   // extrapolation stops at 350 ms
    expect(at(10.39).collidable).toBe(true);
    expect(at(10.41).collidable).toBe(false);
    expect(at(10.4).alpha).toBe(1);
    expect(at(11).alpha).toBeCloseTo(0.5, 6);
    expect(at(12).alpha).toBe(0);
  });

  it('drops duplicates and late packets, and interpolates between states in the past', () => {
    const car = new RemoteCar(), out = emptySample();
    const st = (seq: number, time: number, z: number) => ({ ...emptyCarState(), seq, time, z, vz: 50 });
    expect(car.push(st(10, 1, 0), 1)).toBe(true);
    expect(car.push(st(12, 1.1, 5), 1.1)).toBe(true);
    expect(car.push(st(11, 1.05, 2.5), 1.1)).toBe(false);   // late: older than the newest
    expect(car.push(st(12, 1.1, 5), 1.1)).toBe(false);      // duplicate
    expect(car.push(st(5, 1.2, 10), 1.2)).toBe(false);      // older sequence
    expect(car.push(st(65535, 2, 0), 1.2)).toBe(false);     // 'newer' only across the wrap from 12: it is older
    expect(car.stats).toMatchObject({ received: 6, accepted: 2, stale: 4 });
    expect(car.sample(1.05, out, false)!.z).toBeCloseTo(2.5, 6);   // Hermite through two states at 50 m/s
    expect(out.age).toBeCloseTo(-0.05, 6);
    expect(car.sample(0.5, out, false)!.z).toBe(0);         // before the oldest: held
    expect(car.push(st(13, 9, 0), 1.2)).toBe(false);        // stamped 7.8 s ahead: a broken clock
  });

  it('blends a correction out instead of snapping, snaps after a restart, and obeys noCollide', () => {
    const car = new RemoteCar(), out = emptySample();
    car.push({ ...emptyCarState(), seq: 1, time: 0, vz: 50 }, 0);
    car.sample(0.1, out);
    expect(out.z).toBeCloseTo(5, 6);
    // the next state says the car is 1 m to the left of where it was predicted
    car.push({ ...emptyCarState(), seq: 2, time: 0.1, x: 1, z: 5, vz: 50 }, 0.1);
    expect(car.sample(0.1, out)!.x).toBeCloseTo(0, 6);       // still drawn where it was
    expect(out.correction).toBeCloseTo(1, 6);
    expect(car.sample(0.15, out)!.x).toBeCloseTo(1 - Math.exp(-1), 6);   // decaying with tau 0.05 s
    expect(car.sample(0.4, out)!.x).toBeGreaterThan(0.99);
    // restarted: a new epoch, far away, no blending
    car.push({ ...emptyCarState(), seq: 3, time: 0.6, x: -500, epoch: 1, flags: STATE_FLAG.noCollide }, 0.6);
    expect(car.sample(0.6, out)!.x).toBe(-500);
    expect(out.collidable).toBe(false);
    expect(car.stats.snaps).toBe(1);
  });
});
