// Ghost laps (src/ghost.ts, recorded by Timing): recording and packing, playback, storage and when a lap becomes
// the ghost. The timing rules run with a scripted car on the centreline (fast: no physics); the playback accuracy
// with a real autopilot lap.
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { DT } from '../src/config';
import { GHOST_SUFFIX, GHOST_TICKS, ghostPose, loadGhost, unpackGhost, type GhostLap, type GhostPose } from '../src/ghost';
import { clearStore, loadStore, Timing } from '../src/timing';
import { pointAt, projectOnTrack, type Track } from '../src/track';
import type { Vehicle } from '../src/vehicle';
import { session, trackFor } from './harness';

afterEach(() => localStorage.clear());

const KEY = 'test.best';
const pose = (): GhostPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, dist: 0 });
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// A car that follows the centreline, weaving a little and pitching, rolling and steering on sine waves, ticked
// through Timing as stepPhysics does. Every tick's pose is kept (by tick number) to compare the recording with.
function scripted(track: Track, timing: Timing) {
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const car = {
    pos: new THREE.Vector3(), quat: new THREE.Quaternion(), prevPos: new THREE.Vector3(), prevQuat: new THREE.Quaternion(),
    steer: 0, proj: { i: 0, s: 0, lat: 0 }, wheels: [0, 1, 2, 3].map(() => ({ out: false })),
  };
  const truth = new Map<number, { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; steer: number }>();
  let s = track.L - 40, tick = 0;
  const place = () => {
    const t = tick * DT, p = pointAt(track, s, 1.5 * Math.sin(t * 0.7)), i = p.i;
    const yaw = Math.atan2(track.TX[i], track.TZ[i]), pitch = 0.02 * Math.sin(t * 3), roll = 0.03 * Math.cos(t * 2), steer = 0.1 * Math.sin(t);
    car.pos.set(p.x, 0.3 + 0.1 * Math.sin(t), p.z); car.quat.setFromEuler(e.set(pitch, yaw, roll, 'YXZ'));
    car.steer = steer; car.proj.s = ((s % track.L) + track.L) % track.L;
    truth.set(tick, { x: car.pos.x, y: car.pos.y, z: car.pos.z, yaw, pitch, roll, steer });
  };
  place();
  // Drive at `speed` (m/s) until done() after a tick; during() after every tick.
  const run = (speed: number, done: () => boolean, during?: () => void) => {
    while (!done()) {
      car.prevPos.copy(car.pos); car.prevQuat.copy(car.quat);
      const t0 = tick * DT;
      s += speed * DT; tick++;
      place();
      timing.tick(car.prevPos, car.pos, t0, DT, car as unknown as Vehicle);
      during?.();
    }
  };
  // One whole lap from the line (the lap is under way): returns when it started.
  const lap = (speed: number, during?: () => void) => {
    const n = timing.laps.length, start = timing.lapStart!;
    run(speed, () => timing.laps.length > n, during);
    return start;
  };
  return { run, lap, truth };
}
type Truth = ReturnType<typeof scripted>['truth'];

// The ghost's samples against the poses the car had then (lapStart: when that lap started).
function checkSamples(g: GhostLap, lapStart: number, truth: Truth) {
  const out = pose();
  const worst = { pos: 0, yaw: 0, tilt: 0, steer: 0 };
  for (let k = 0; k < g.n; k++) {
    const t = k === g.n - 1 ? g.tEnd : g.t0 + k * g.h;
    const tr = truth.get(Math.round((lapStart + t) / DT))!;
    ghostPose(g, t, out);
    worst.pos = Math.max(worst.pos, Math.abs(out.x - tr.x), Math.abs(out.y - tr.y), Math.abs(out.z - tr.z));
    worst.yaw = Math.max(worst.yaw, Math.abs(wrap(out.yaw - tr.yaw)));
    worst.tilt = Math.max(worst.tilt, Math.abs(out.pitch - tr.pitch), Math.abs(out.roll - tr.roll));
    worst.steer = Math.max(worst.steer, Math.abs(out.steer - tr.steer));
  }
  // half a quantisation step each (5 mm, 2^-16 turn, 0.125 deg, 0.005 rad), plus rounding
  expect(worst.pos).toBeLessThan(0.0051);
  expect(worst.yaw).toBeLessThan(Math.PI / 32768 / 2 + 1e-6);
  expect(worst.tilt).toBeLessThan((0.125 * Math.PI) / 180 + 1e-6);
  expect(worst.steer).toBeLessThan(0.0051);
}

// How far a pose is past the start/finish line, along the track (m).
const pastLine = (track: Track, p: GhostPose) => (p.x - track.X[0]) * track.TX[0] + (p.z - track.Z[0]) * track.TZ[0];

describe('ghost recording', () => {
  it('becomes the ghost on a new valid best lap only, saved and loaded intact, and is cleared with the best times', async () => {
    const track = await trackFor('melbourne'), timing = new Timing(track, KEY);
    const { run, lap, truth } = scripted(track, timing);
    run(60, () => timing.lapStart != null);   // out to the line: the first lap starts there
    expect(timing.ghost).toBeNull();          // the first ever lap: nothing to race yet
    expect(timing.lastRecording).toBeNull();

    let start = lap(60);
    const first = timing.ghost!;
    expect(first.lapTime).toBe(timing.store.bestLap);
    expect(first.t0).toBeLessThanOrEqual(0); expect(first.t0).toBeGreaterThanOrEqual(-DT);
    expect(first.h).toBeCloseTo(GHOST_TICKS * DT, 12);
    checkSamples(first, start, truth);
    const at = pose();
    expect(Math.abs(pastLine(track, ghostPose(first, 0, at)))).toBeLessThan(0.01);
    expect(Math.abs(pastLine(track, ghostPose(first, first.lapTime, at)))).toBeLessThan(0.01);
    expect(loadGhost(KEY, timing.store.bestLap)).toEqual(first);
    const stored = localStorage.getItem(KEY + GHOST_SUFFIX)!;
    expect(first.bytes).toBe(49 + 11 * first.n);   // 884 samples for this 88 s lap: 9.8 kB, 13 k characters stored
    expect(stored.length).toBe(Math.ceil(first.bytes / 3) * 4);

    // a faster lap with the track limits broken: deleted, and the ghost stays
    lap(70, () => { if (timing.valid && timing.trace.length > 200) timing.invalidate('TRACK LIMITS'); });
    expect(timing.laps[0].valid).toBe(false);
    expect(timing.ghost).toBe(first);
    // (every finished lap's recording is kept until the next, valid or not: the lap tests take the autopilot's)
    expect(unpackGhost(timing.lastRecording!)!.lapTime).toBe(timing.laps[0].time);
    expect(localStorage.getItem(KEY + GHOST_SUFFIX)).toBe(stored);

    // the same, valid: the new ghost
    start = lap(70);
    const second = timing.ghost!;
    expect(second.lapTime).toBeLessThan(first.lapTime);
    expect(second.lapTime).toBe(timing.store.bestLap);
    checkSamples(second, start, truth);
    expect(new Timing(track, KEY).ghost).toEqual(second);   // as a reload finds it

    // a slower valid lap leaves it; a restart mid-lap drops that lap's recording, and the next lap records afresh
    lap(65);
    expect(timing.ghost).toBe(second);
    run(80, () => timing.trace.length > 300);
    timing.reset();
    run(80, () => timing.lapStart != null);
    start = lap(80);
    expect(timing.ghost!.lapTime).toBeLessThan(second.lapTime);
    checkSamples(timing.ghost!, start, truth);

    // Reset best times
    clearStore(KEY); timing.useStore(KEY);
    expect(timing.ghost).toBeNull();
    expect(timing.lastRecording).toBeNull();
    expect(timing.store.bestLap).toBeNull();
    expect(localStorage.getItem(KEY + GHOST_SUFFIX)).toBeNull();
  });

  it('keeps the best times when storage has no room for the recording', async () => {
    const track = await trackFor('melbourne'), timing = new Timing(track, KEY);
    const { run, lap } = scripted(track, timing);
    const setItem = localStorage.setItem;
    localStorage.setItem = (k: string, v: string) => {
      if (k.endsWith(GHOST_SUFFIX)) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(localStorage, k, v);
    };
    try {
      run(60, () => timing.lapStart != null);
      lap(60);
    } finally { localStorage.setItem = setItem; }
    expect(timing.ghostSaved).toBe(false);
    expect(timing.ghost).not.toBeNull();       // still raced against for the rest of the session
    expect(loadStore(KEY).bestLap).toBe(timing.laps[0].time);
    expect(localStorage.getItem(KEY + GHOST_SUFFIX)).toBeNull();
    expect(new Timing(track, KEY).ghost).toBeNull();
  });
});

describe('loadGhost', () => {
  it('ignores corrupt, old-format and mismatched data', async () => {
    const track = await trackFor('melbourne'), timing = new Timing(track, KEY);
    const { run, lap } = scripted(track, timing);
    run(60, () => timing.lapStart != null);
    lap(60);
    const best = timing.store.bestLap!, good = localStorage.getItem(KEY + GHOST_SUFFIX)!;
    expect(loadGhost(KEY, best)).not.toBeNull();
    expect(loadGhost(KEY, best + 0.001)).toBeNull();   // not the recording of the best lap
    expect(loadGhost(KEY, null)).toBeNull();
    const bytes = Uint8Array.from(atob(good), (c) => c.charCodeAt(0));
    const variant = (f: (v: DataView) => void) => {
      const b = bytes.slice(); f(new DataView(b.buffer));
      let s = ''; for (const c of b) s += String.fromCharCode(c);
      return btoa(s);
    };
    const bad = [
      '', 'not base64 at all!', btoa('short'), good.slice(0, good.length - 8), good + 'AAAA', '{"bestLap":1}',
      variant((v) => v.setUint8(0, 2)),                          // another format version
      variant((v) => v.setUint32(33, 3, true)),                  // sample count against the length
      variant((v) => v.setFloat64(17, NaN, true)),               // sample spacing
      variant((v) => v.setFloat64(9, 5, true)),                  // first sample after the line
      variant((v) => v.setFloat64(25, 1e9, true)),               // end time far past the last sample
    ];
    for (const raw of bad) {
      localStorage.setItem(KEY + GHOST_SUFFIX, raw);
      expect(loadGhost(KEY, best)).toBeNull();
      const reloaded = new Timing(track, KEY);
      expect(reloaded.ghost).toBeNull();
      expect(reloaded.store.bestLap).toBe(best);             // the best times load regardless
    }
    expect(unpackGhost(new Uint8Array(0))).toBeNull();
  });
});

describe('ghost playback', () => {
  it('follows an autopilot lap between its samples, from the line at 0 to the line at the lap time', async () => {
    const { session: s, timing, track, car, drive } = await session('drift', { flying: true });
    const t: number[] = [], x: number[] = [], z: number[] = [], yaw: number[] = [];
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    drive(200, null, () => {
      if (timing.lapStart != null && timing.laps.length === 0) {
        t.push(s.simTime - timing.lapStart); x.push(car.pos.x); z.push(car.pos.z); yaw.push(e.setFromQuaternion(car.quat, 'YXZ').y);
      }
      return timing.laps.length === 1;
    });
    const g = timing.ghost!;
    expect(timing.laps[0].valid).toBe(true);
    expect(g.lapTime).toBe(timing.laps[0].time);
    const p = pose();
    expect(Math.abs(pastLine(track, ghostPose(g, 0, p)))).toBeLessThan(0.05);
    expect(Math.abs(pastLine(track, ghostPose(g, g.lapTime, p)))).toBeLessThan(0.05);
    // every tick of the lap, between the 10 Hz samples (1.0 cm and 0.14 deg at worst). The drift car, because
    // LibreCorsa's engine runs 4 or 5 of its 2 ms steps per tick: its cars' per-tick positions are themselves up to
    // a step (15 cm at speed) off an even pace, while every 12 ticks is exactly 50 steps, so the ghost is the smoother.
    let pos = 0, ang = 0;
    for (let k = 0; k < t.length; k++) {
      ghostPose(g, t[k], p);
      pos = Math.max(pos, Math.hypot(p.x - x[k], p.z - z[k]));
      ang = Math.max(ang, Math.abs(wrap(p.yaw - yaw[k])));
    }
    expect(pos).toBeLessThan(0.02);
    expect(ang).toBeLessThan((0.25 * Math.PI) / 180);
    // the delta trace agrees with the ghost: where the ghost is t seconds into its lap, the best lap's trace says t,
    // so the live delta reads zero when the car is level with it
    const proj = { i: -1, s: 0, lat: 0 }, tr = timing.store.bestTrace!;
    for (let tt = 5; tt < g.lapTime - 5; tt += 5) {
      ghostPose(g, tt, p);
      projectOnTrack(track, p.x, p.z, -1, proj);
      const f = proj.s / 10, b = Math.floor(f);
      expect(Math.abs(tr[b] + (tr[b + 1] - tr[b]) * (f - b) - tt)).toBeLessThan(0.05);
    }
  });
});
