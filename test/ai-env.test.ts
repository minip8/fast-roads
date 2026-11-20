import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { autopilot } from '../src/autopilot';
import { CARS, type CarId, type LcSpec } from '../src/cars';
import type { DeepPartial, EnvConfig } from '../src/ai/config';
import { END, getTrack, INFO, INFO_FIELDS, RaceEnv, speedProfile } from '../src/ai/env';
import { CAR_IDS, observationSpec, observe, steerLockOf } from '../src/ai/observation';
import { VecEnv } from '../src/ai/vec';
import { LcCar } from '../src/lc/lcCar';
import { inPitLane, pointAt } from '../src/track';
import { TRACKS, type TrackId } from '../src/tracks';
import { ourCar } from './harness';

// The RL environment (src/ai) over the game's own Session: specs, determinism, the autopilot's pinned lap through
// it, random starts, episode ends and automatic resets. The worker's protocol is tested in ai-worker.test.ts.

const ALL: CarId[] = ['lcf1', 'lcgt3', 'drift'];
const env = (config: DeepPartial<EnvConfig> = {}, seed = 1) => RaceEnv.create(config, seed);
const at = (e: RaceEnv, name: string) => e.obs[e.spec.findIndex((s) => s.name === name)];
// a fixed pseudo-random action sequence
const actions = (seed: number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 31 - 1; }; };

describe('observation', () => {
  it('matches its spec: one entry per element, named values where they should be', async () => {
    const e = await env({ reset: { cars: ALL } });
    const spec = observationSpec(e.cfg.obs);
    expect(spec.map((s) => s.index)).toEqual(spec.map((_, i) => i));
    expect(new Set(spec.map((s) => s.name)).size).toBe(spec.length);
    expect(spec.length).toBe(68 + 6 * e.cfg.obs.lookahead);   // (docs/ai-env.md: 164 by default)
    expect(spec.slice(15, 19).map((s) => s.name)).toEqual(['off_track', 'in_pit_lane', 'pit_left', 'pit_right']);
    expect(spec.filter((s) => s.name.startsWith('look0_')).map((s) => s.name.slice(6))).toEqual(['curv', 'wl', 'wr', 'sin', 'cos', 'pit']);
    expect(INFO_FIELDS.slice(-2)).toEqual(['pit_lane_time', 'reward_pit_lane']);   // (appended: the older indices stay)
    expect(INFO.episode).toBe(27);
    for (const car of ALL) {
      e.reset({ car, start: 'flying' });
      expect(e.obs.length).toBe(spec.length);
      expect([...e.obs].every((v) => Number.isFinite(v) && Math.abs(v) <= 10)).toBe(true);
      const c = e.car;
      for (const id of CAR_IDS) expect(at(e, `car_${id}`)).toBe(id === car ? 1 : 0);
      expect(at(e, 'speed_fwd')).toBeCloseTo(c.speedF / 100, 5);
      expect(at(e, 'speed_fwd') * 100 * 3.6).toBeCloseTo(TRACKS.melbourne.flying[car], 0);
      expect(at(e, 'heading_cos')).toBeGreaterThan(0.999);
      expect(Math.abs(at(e, 'lat_norm'))).toBeLessThan(0.05);
      expect(at(e, 'wheel_fl_asphalt') + at(e, 'wheel_rr_asphalt')).toBe(2);
      expect(at(e, 'tyres_present')).toBe(car === 'drift' ? 0 : 1);
      expect(at(e, 'battery_present')).toBe(car === 'lcf1' ? 1 : 0);
      expect(at(e, 'flaps_fitted')).toBe(car === 'lcf1' ? 1 : 0);
      expect(at(e, 'gear')).toBeGreaterThan(0);
      expect(at(e, 'in_pit_lane')).toBe(0);
      // a pure function of the state: the same vector again
      const again = new Float32Array(spec.length);
      observe(again, c, e.track, e.proj, { steerLock: steerLockOf(c.spec), targetSteer: 0, targetPedal: 0, cmdSteer: 0, cmdPedal: 0, prevSteer: 0, prevPedal: 0, wallContact: false, wallHit: 0 }, e.cfg.obs);
      expect(again).toEqual(e.obs);
    }
  });

  it('reports the steering and pedal commands after the slew limit, and integrates delta actions', async () => {
    const e = await env({ reset: { cars: ['drift'] } });
    e.reset({ start: 'flying' });
    e.step(1, 0.5);
    expect(at(e, 'target_steer')).toBe(1);
    expect(at(e, 'cmd_steer')).toBeCloseTo(0.15, 5);   // 3 locks/s for 6 ticks of 1/120 s
    expect(at(e, 'cmd_pedal')).toBe(0.5);
    const d = await env({ actionMode: 'delta', reset: { cars: ['drift'] } });
    d.reset({ start: 'flying' });
    d.step(1, -1); d.step(1, -1);
    expect(at(d, 'target_steer')).toBeCloseTo(0.5, 6);
    expect(at(d, 'target_pedal')).toBe(-1);
    expect(at(d, 'prev_steer')).toBe(1);
  });
});

describe('determinism', () => {
  const run = async (seed: number) => {
    const v = await VecEnv.create(3, { episodeSecs: 3, reset: { tracks: ['melbourne', 'monaco'], cars: ALL } }, seed);
    await v.reset();
    const rnd = actions(9), out: number[] = [], a = new Float32Array(6);
    for (let s = 0; s < 80; s++) {
      for (let k = 0; k < 6; k++) a[k] = k % 2 ? 0.4 + 0.6 * rnd() : 0.3 * rnd();
      v.step(a);
      out.push(...v.obs, ...v.reward, ...v.terminated, ...v.truncated, ...v.info, ...v.done);
    }
    v.dispose();
    return out;
  };
  it('the same seed and actions give bit-identical observations, rewards and info', async () => {
    const a = await run(5), b = await run(5);
    expect(a.length).toBe(b.length);
    expect(a.every((x, i) => Object.is(x, b[i]))).toBe(true);
    const c = await run(6);   // and another seed is another run
    expect(c.some((x, i) => !Object.is(x, a[i]))).toBe(true);
  });

  it('an episode does not depend on the episodes before it', async () => {
    for (const car of ['drift', 'lcgt3'] as CarId[]) {
      const episode = (e: RaceEnv) => {
        e.reset({ seed: 5, car });
        const out: number[] = [];
        for (let n = 0; n < 40; n++) { const r = e.step(0.1, 1); out.push(r.reward, ...e.obs); }
        return out;
      };
      const fresh = episode(await env({ reset: { cars: [car] } }));
      const used = await env({ reset: { cars: [car] } });
      for (let k = 0; k < 2; k++) {   // two episodes into the wall first
        used.reset({ seed: k, s: getTrack('melbourne').L - 120, heading: 0.5, speed: 30 });
        for (let n = 0; n < 30 && !used.step(1, 1).terminated; n++);
      }
      const after = episode(used);
      expect(after.every((x, i) => Object.is(x, fresh[i]))).toBe(true);
    }
  });
});

describe('autopilot through the environment', () => {
  it('drives the pinned lcf1 lap at Melbourne in evaluation mode, timed by the game', async () => {
    const e = await env({ reset: { cars: ['lcf1'] } });
    e.reset({ eval: true });
    let progress = 0, other = 0;
    for (let n = 0; n < 4000; n++) {
      const r = e.step(NaN, NaN);   // NaN: the autopilot drives
      progress += e.info[INFO.reward_progress];
      other += e.info[INFO.reward_wall] + e.info[INFO.reward_off_track] + e.info[INFO.reward_pit_lane] + e.info[INFO.pit_lane_time];
      expect(e.info[INFO.autopilot_steer]).toBeGreaterThanOrEqual(-1);
      if (r.terminated || r.truncated) {
        expect(r.truncated && !r.terminated).toBe(true);
        break;
      }
    }
    const i = e.info;
    expect(i[INFO.end_reason]).toBe(END.lapDone);
    expect(i[INFO.lap_time].toFixed(3)).toBe('116.548');   // as test/laps.ts pins it
    expect(i[INFO.lap_valid]).toBe(1);
    expect(i[INFO.sector1] + i[INFO.sector2] + i[INFO.sector3]).toBeCloseTo(i[INFO.lap_time], 6);
    // the progress reward sums to the distance from the start spot round to the line (to within the last step)
    expect(progress).toBeGreaterThan(e.track.L + TRACKS.melbourne.startBack - 5);
    expect(progress).toBeLessThan(e.track.L + TRACKS.melbourne.startBack + 1);
    expect(other).toBe(0);
  });

  it('turned into 20 Hz actions, keeps the GT3 on the road', async () => {
    const e = await env({ reset: { cars: ['lcgt3'] } });
    e.reset({ start: 'flying' });
    const lock = steerLockOf(CARS.lcgt3);
    let off = 0;
    for (let n = 0; n < 600; n++) {   // 30 s
      const ap = autopilot(e.car, e.track);
      const r = e.step(ap.steerAngle! / lock, ap.throttle - ap.brake);
      off += e.info[INFO.off_track_time];
      expect(r.terminated).toBe(false);
    }
    expect(off).toBe(0);
    expect(e.info[INFO.wall_contact]).toBe(0);
    // about as far as the autopilot itself gets in that time (at 120 Hz, its steering straight to the wheels)
    const viaActions = e.info[INFO.episode_progress_m];
    e.reset({ start: 'flying' });
    for (let n = 0; n < 600; n++) e.step(NaN, NaN);
    expect(viaActions).toBeGreaterThan(0.97 * e.info[INFO.episode_progress_m]);
  });
});

describe('the pit lane', () => {
  it("is in the observation, earns no progress and costs its penalty, and the game's timing deletes the lap", async () => {
    // Melbourne's lane is on the right; its exit (open to the track from the pit wall's tail, 88 m after the line,
    // until it rejoins the road at 163 m) is after the line, so a lap is under way there. From the right of the start
    // straight, over the line, then steering right into the exit.
    const e = await env({ reset: { cars: ['lcf1'] } }), tr = getTrack('melbourne');
    e.reset({ s: tr.L - 30, lat: -(tr.WR[pointAt(tr, tr.L - 30).i] - 2), heading: 0, speed: 25 });
    const lookPit = () => e.spec.filter((x) => /^look\d+_pit$/.test(x.name)).map((x) => e.obs[x.index]);
    expect(at(e, 'in_pit_lane')).toBe(0);
    expect(at(e, 'pit_right')).toBe(0);
    expect(lookPit()).toContain(-1);          // the exit's open stretch ahead, on the right
    expect(lookPit()).not.toContain(1);
    let sawSide = false, entered = -1, inside = 0;
    for (let n = 0; n < 120; n++) {
      const s = e.info[INFO.lap_s], lat = e.info[INFO.lat];
      const before = e.info[INFO.lap_valid_now];
      // straight on to 90 m past the line, then out to 4 m beyond the right edge
      const steer = s > 90 && s < 1000 ? Math.max(-0.15, Math.min(0.15, -0.08 * (lat + tr.WR[e.proj.i] + 4))) : 0;
      const r = e.step(steer, 0.3);
      const i = e.info;
      expect(r.terminated || r.truncated).toBe(false);
      expect(r.reward).toBeCloseTo(i[INFO.reward_progress] + i[INFO.reward_wall] + i[INFO.reward_off_track] + i[INFO.reward_smooth]
        + i[INFO.reward_terminal] + i[INFO.reward_pit_lane], 9);
      if (at(e, 'pit_right') && !at(e, 'in_pit_lane')) sawSide = true;
      expect(at(e, 'in_pit_lane')).toBe(inPitLane(tr, e.car.pos.x, e.car.pos.z, e.car.proj.i) ? 1 : 0);
      expect(i[INFO.reward_pit_lane]).toBeCloseTo(-e.cfg.reward.pitLane * i[INFO.pit_lane_time], 12);
      if (i[INFO.pit_lane_time] > 0 && entered < 0) {
        entered = n;
        expect(before).toBe(1);                       // a valid lap under way...
        expect(i[INFO.lap_valid_now]).toBe(0);        // ...deleted in this very step (PIT LANE)
        expect(e.session.timing.invalidReason).toBe('PIT LANE');
        expect(i[INFO.off_track_time]).toBe(0);       // (on asphalt, inside the track limits: nothing else says so)
      }
      if (i[INFO.pit_lane_time] === 0.05) {           // a whole step in the lane: no progress paid
        inside++;
        expect(at(e, 'in_pit_lane')).toBe(1);
        expect(i[INFO.progress_m]).toBeGreaterThan(0.5);
        expect(i[INFO.reward_progress]).toBe(0);
        expect(i[INFO.reward_pit_lane]).toBeCloseTo(-0.25, 12);
      }
      if (i[INFO.lap_valid_now] === 0 && e.info[INFO.lap_s] > 200) break;
    }
    expect(sawSide).toBe(true);
    expect(entered).toBeGreaterThan(0);
    expect(inside).toBeGreaterThan(0);
  });
});

describe('random starts', () => {
  for (const track of ['melbourne', 'monaco'] as TrackId[]) {
    it(`put each car on the track at ${track}, facing the right way, at the speed asked for`, async () => {
      const e = await env({ reset: { tracks: [track], cars: ALL } }, 3);
      for (const car of ALL) {
        for (let k = 0; k < 3; k++) {
          e.reset({ car });
          const c = e.car, p = e.proj, tr = e.track;
          expect(c.spec.id).toBe(car);
          expect(p.lat).toBeLessThan(tr.WL[p.i] - 0.5);
          expect(p.lat).toBeGreaterThan(-tr.WR[p.i] + 0.5);
          expect(at(e, 'heading_cos')).toBeGreaterThan(Math.cos(e.cfg.reset.headingMax) - 1e-3);
          const prof = speedProfile(tr, car)[p.i];
          expect(c.speedF).toBeGreaterThan(prof * e.cfg.reset.speedFrac[0] - 1);
          expect(c.speedF).toBeLessThan(prof * e.cfg.reset.speedFrac[1] + 1);
          expect(c.wheels.some((w) => w.out)).toBe(false);
          expect(c.up.y).toBeGreaterThan(0.99);
          expect(e.info[INFO.laps]).toBe(0);
          expect(e.info[INFO.lap_valid_now]).toBeNaN();
        }
        // and a chosen pose exactly
        e.reset({ car, s: 700, lat: 1.5, heading: 0.1, speed: 30 });
        expect(e.car.speedF).toBeCloseTo(30, 0);
        expect(e.proj.lat).toBeCloseTo(1.5, 1);
        expect(Math.asin(at(e, 'heading_sin'))).toBeCloseTo(0.1, 2);
        // a fresh car each episode: the battery full again, the tyres back at their start heat (as on a lap: warmTyres)
        if (car !== 'drift') {
          const spec = CARS[car] as LcSpec, start = spec.warmTyres.rear.core.reduce((a, b) => a + b) / 3;
          expect(e.car.tyres!.wheels[2].coreC).toBeCloseTo(start, 6);
          for (let n = 0; n < 40; n++) e.step(0, 1);
          const worked = e.car.tyres!.wheels[2].coreC, bat = e.car.battery;
          expect(worked).not.toBeCloseTo(start, 2);
          e.reset({ car, s: 700, lat: 1.5, heading: 0.1, speed: 30 });
          expect(e.car.tyres!.wheels[2].coreC).toBeCloseTo(start, 6);
          if (car === 'lcf1') expect(e.car.battery).toBeGreaterThan(bat!);
        }
      }
    });
  }
});

describe('episode ends', () => {
  it('terminates driving the wrong way', async () => {
    const e = await env({ reset: { cars: ['lcgt3'] } });
    e.reset({ s: getTrack('melbourne').L - 40, heading: Math.PI, speed: 15 });
    for (let n = 0; n < 100 && !e.step(0, 0).terminated; n++);
    expect(e.info[INFO.end_reason]).toBe(END.wrongWay);
    expect(e.info[INFO.episode_progress_m]).toBeLessThan(-30);
    expect(e.info[INFO.reward_terminal]).toBe(-e.cfg.reward.terminal);
  });

  it('terminates stuck, and without that rule the car just sits there (no session restart)', async () => {
    const e = await env({ reset: { cars: ['drift'] } });
    let restarts = 0;
    e.reset({ s: 500, speed: 0 });
    e.session.onReset = () => { restarts++; };
    let n = 0;
    while (!e.step(0, 0).terminated) n++;
    expect(e.info[INFO.end_reason]).toBe(END.stuck);
    expect(e.info[INFO.episode_time]).toBeCloseTo(3, 6);
    const still = await env({ termination: { stuckSecs: 0 }, reset: { cars: ['drift'] } });
    still.reset({ s: 500, speed: 0 });
    still.session.onReset = () => { restarts++; };
    const where = still.car.pos.clone();
    for (n = 0; n < 120; n++) expect(still.step(0, 0).terminated).toBe(false);   // 6 s: Session.tick would have restarted the autopilot after 3
    expect(still.car.pos.distanceTo(where)).toBeLessThan(0.5);
    expect(restarts).toBe(0);
  });

  it('terminates a car on its roof instead of putting it back on the track, on both engines', async () => {
    for (const car of ['drift', 'lcf1'] as CarId[]) {
      const e = await env({ reset: { cars: [car] } });
      e.reset({ s: 500, speed: 0 });
      let restarts = 0;
      e.session.onReset = () => { restarts++; };
      const roof = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI));
      if (car === 'drift') ourCar(e.car).body.setRotation(roof, true);
      else (e.car as LcCar).vehicle.quaternion.copy(roof);
      const where = e.car.pos.clone();
      let r = e.step(0, 0);
      for (let n = 0; n < 60 && !r.terminated; n++) r = e.step(0, 0);
      expect(r.terminated).toBe(true);
      expect(e.info[INFO.end_reason]).toBe(END.flipped);
      expect(restarts).toBe(0);
      expect(e.car.pos.distanceTo(where)).toBeLessThan(5);   // not moved to the start spot
    }
  });

  it('truncates at the time limit', async () => {
    const e = await env({ episodeSecs: 2, reset: { cars: ['lcf1'] } });
    e.reset({ start: 'flying' });
    for (let n = 1; n <= 40; n++) {
      const r = e.step(NaN, NaN);
      expect(r.truncated).toBe(n === 40);
      expect(r.terminated).toBe(false);
    }
    expect(e.info[INFO.end_reason]).toBe(END.timeLimit);
    expect(e.info[INFO.reward_terminal]).toBe(0);
    expect(() => e.step(0, 0)).toThrow();
  });

  for (const car of ['drift', 'lcf1'] as CarId[]) {
    it(`reports a wall hit by its speed and can end the episode on it (${car})`, async () => {
      const e = await env({ termination: { wallImpactMs: 3 }, reset: { cars: [car] } });
      e.reset({ s: getTrack('melbourne').L - 120, lat: 0, heading: 0.5, speed: 30 });   // across the walled start straight
      let hit = 0;
      for (let n = 0; n < 60 && !e.step(0, 0).terminated; n++) hit = Math.max(hit, e.info[INFO.wall_hit]);
      expect(e.info[INFO.end_reason]).toBe(END.wall);
      expect(e.info[INFO.wall_contact]).toBe(1);
      // about 30 sin(0.5) = 14 m/s into the wall, less what the tyres scrubbed off on the way
      expect(e.info[INFO.wall_hit]).toBeGreaterThan(5);
      expect(e.info[INFO.wall_hit]).toBeLessThan(16);
      expect(e.info[INFO.reward_wall]).toBeLessThan(-5);
      expect(hit).toBeLessThan(3);   // nothing before the hit
    });
  }
});

describe('vector environment', () => {
  it('resets an environment whose episode ended, keeping its final observation and info', async () => {
    const cfg = { episodeSecs: 1, reset: { cars: ['lcgt3', 'drift'] as CarId[] } };
    const v = await VecEnv.create(2, cfg, 11);
    await v.reset({ start: 'flying' });
    const solo = await env(cfg, 12);   // environment 1 of the vector draws from seed + 1
    solo.reset({ start: 'flying' });
    const nan = new Float32Array(4).fill(Number.NaN);
    for (let n = 1; n <= 20; n++) {
      v.step(nan);
      solo.step(NaN, NaN);
      expect(v.done.length).toBe(n === 20 ? 2 : 0);
    }
    expect([...v.truncated]).toEqual([1, 1]);
    const D = v.obsSize, F = INFO_FIELDS.length;
    expect(v.finalObs.subarray(D, 2 * D)).toEqual(solo.obs);   // the finished episode's last observation
    expect(v.info.subarray(F, 2 * F)).toEqual(solo.info);      // ...and its last info
    expect(v.info[F + INFO.episode]).toBe(1);
    expect(v.obs.subarray(D, 2 * D)).not.toEqual(solo.obs);    // the new episode's first observation
    expect(v.envs[1].simTime).toBe(0);
    v.step(nan);
    expect(v.info[F + INFO.episode]).toBe(2);
    expect(v.info[F + INFO.episode_time]).toBeCloseTo(0.05, 9);
    v.dispose();
  });
});
