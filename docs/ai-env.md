# RL environment and worker protocol

A reinforcement-learning environment over the game's own simulation, for training a time-trial driver: one car on
an empty circuit, any of the 24 circuits, cars `lcf1` (2026 F1, LibreCorsa engine), `lcgt3` (GT3, LibreCorsa engine)
and `drift` (rear-drive coupe, the game's own Rapier physics). This document is the reference for writing a trainer
against it; nothing else is needed.

- `src/ai/`: the environment, in the game's TypeScript (it changes with the physics, in the same commits).
  `env.ts` (`RaceEnv`: reset/step over the game's `Session`), `vec.ts` (`VecEnv`: N of them as a batch, with
  automatic resets), `observation.ts` (the observation, a pure function the browser can reuse), `control.ts` (an
  action's way to the car and what the observation reads besides it, shared with the game's policy driver),
  `config.ts` (every setting and its default), `walls.ts` (wall contact per engine), `rng.ts`, `protocol.ts` (the
  wire format); and for trained policies in the game, `policy.ts` and `policyDriver.ts` (below).
- `ai/worker.ts`: the worker process (stdin/stdout). `ai/client.mjs` and `ai/client.py`: reference clients.

Every circuit includes its real pit lane, as the game builds it (`src/pitLane.ts`, `src/circuit.ts`), with nothing of
the race weekends' rules (no limiter, no stops). What it means here: its pit wall and far wall are walls for both
engines (`wall_contact`, `wall_hit`, the `wall` end); beside the lane the track's barrier on that side is the pit
wall's face, which `wall_left` / `wall_right` read like any barrier (the lane's own walls are not in those two); its
road is asphalt and inside the track limits (`wheel_*_asphalt`, never `*_out` or `off_track` there); and a lap that
goes into it is invalid (`lap_valid` 0, the game's PIT LANE rule: `Timing.pitLaneInvalid` stays on). The rule is the
car's centre on the lane's road and off the track's (`inPitLane` in `src/track.ts`), which can happen without passing
any wall where the lane is open to the track: its entry before the pit wall's nose and its exit after the tail (40 to
310 m of each lap, on the lane's side; where the lane's road meets the track's edge it covers the kerb there too). So
the environment treats the lane as it treats leaving the track: the observation says where it is open (`pit_left`,
`pit_right`, `look{k}_pit`) and when the car is in it (`in_pit_lane`), ticks in it earn no progress and cost
`reward.pitLane`, and `info` reports the time in it (`pit_lane_time`). Progress is still the centreline's
`projectOnTrack` (not lane-aware), so where a lane cuts inside corners (Silverstone, Shanghai, Madrid) the jumps its
projection makes are capped as any jump is (behind the pit wall the car earns nothing anyway). Random starts are on the
track's road, the autopilot never turns into the lane, and every pinned number below is as it was before the lane.
  `ai/bench.mjs`: throughput. None of it is in the game's bundle: the game imports the policy driver dynamically,
  only for `?autopilot=rl`.

## Build and launch

    npm install
    npm run build:env              # -> build/env/worker.mjs (+ .map), one self-contained file (~4 MB)
    node build/env/worker.mjs      # speaks the protocol on stdin/stdout; logs on stderr
    node ai/client.mjs 4 200       # reference client: 4 envs, 200 random steps
    python3 ai/client.py 4 200     # the same from Python (standard library only)
    node ai/bench.mjs              # throughput per car, reset cost, scaling with processes

`build/env/worker.mjs` needs only Node.js 22 or later (it bundles three.js, Rapier with its WebAssembly inline, and
every circuit's data); it can be copied anywhere. `build/` is git-ignored. Rebuild after every change to the game
(the worker reports the commit it was built from, and whether the tree had uncommitted changes then). Start about
one worker per physical CPU core, each hosting several environments (`numEnvs`): see Throughput.

## The environment

One episode is one car driving one circuit. Each **step** holds one action for `120 / actionHz` physics ticks
(default 20 Hz: 6 ticks of 1/120 s). Every tick is the game's own `stepPhysics` (car physics, Rapier world for the
drift car, lap timing), the same code the game loop and the pinned lap tests run; `Session.tick`'s automatic resets
(a stuck autopilot, a car on its roof) are not used: those situations end the episode instead (terminated), so the
car is never moved behind the learner's back.

### Action

Two float32 values in [-1, 1] (values outside are clipped; NaN means "the autopilot drives this step", below):

| index | name  | absolute mode (default)                                                     |
|-------|-------|-----------------------------------------------------------------------------|
| 0     | steer | steering command as a share of the car's full road-wheel lock, + = left     |
| 1     | pedal | + throttle (0..1), - brake (0..1); never both                               |

In `delta` mode (`actionMode: 'delta'`) each value is a change of that command per step: `target += action x
deltaScale[i]`, clamped to [-1, 1] (defaults `deltaScale` [0.25, 0.5]). Either way the command reaching the car is
slew-limited per tick: steering by `steerRate` full locks per second (default 3: centre to full lock in 0.33 s),
the pedal axis by `pedalRate` per second (default 0: none). Gears are automatic. Traction control is on by default
(`tc`); ABS is always on, on every car (neither engine has a way to turn it off).

**How steering reaches the car**: as a road-wheel angle, `command x lock`, through `DriveInput.steerAngle`, the path
the autopilot uses; the environment does the rate limiting itself. That path goes straight to the road wheels on
both engines (on the drift car the physics adds its own 6 rad/s limit, which the env's limit stays under), so all
three cars get the same, linear control: a share of full lock, with the same slew. Full lock is the car's physical
lock: lcf1 19.3 deg, lcgt3 25.4 deg, drift 51.6 deg (0.9 rad: its travel includes opposite lock). The game's
analog/keyboard paths were not used because they shape the input differently per engine (the drift car scales lock
down with speed, LibreCorsa's keyboard path has its own steering assist, its analog path ramps the pedals).
The useful range at speed is small (at 220 km/h the tyres peak at about 0.27 of the F1's lock), so a policy needs
fine control near 0. Pedals reach the engines as given (no pedal ramps) and the aids then act on them.

**Autopilot steps**: a NaN in either action value of an environment makes the game's autopilot (pure pursuit + speed
plan, exactly as in the game and the pinned lap tests) drive that step, at 120 Hz with its own steering. `info`
reports the equivalent absolute action (`autopilot_steer`, `autopilot_pedal`: its last tick's command), and the
observation's command fields follow it, so a policy can take over smoothly. Useful for demonstrations and to fill a
replay buffer; with only autopilot steps from the flying start, the lap time equals the pinned one (lcf1 Melbourne
116.548 s).

### Observation

A flat float32 vector, 164 values with the default config (`16 look-ahead samples`; the size is
`68 + 6 x obs.lookahead`). Each element is `raw x scale` (after the transform where one is named), then clipped to
[-10, 10] (non-finite values become 0). Fixed constants only, no running statistics. The READY message carries the
full spec (`obsSpec`: name, index, scale, unit, transform, description for every element): use the names, never
hard-coded indices. Everything is track-relative or car-relative except the car one-hot.

| index | name | scale | unit | meaning |
|---|---|---|---|---|
| 0-2 | `car_lcf1`, `car_lcgt3`, `car_drift` | 1 | | car one-hot |
| 3 | `speed_fwd` | 0.01 | m/s | velocity along the car's nose |
| 4 | `speed_lat` | 0.05 | m/s | velocity to the car's left |
| 5 | `yaw_rate` | 0.5 | rad/s | + = turning left |
| 6 | `slip_angle` | 2 | rad | atan2(speed_lat, max(abs(speed_fwd), 3)) |
| 7 | `up_y` | 1 | | vertical component of the car's up axis (1 upright, < 0 on its roof) |
| 8 | `lat_norm` | 1 | | offset from the centreline over the half-width on that side (+-1 at the edges, + = left) |
| 9, 10 | `heading_sin`, `heading_cos` | 1 | | heading error to the track tangent (+ = nose left; cos < 0: facing the wrong way) |
| 11, 12 | `edge_left`, `edge_right` | 0.1 | m | car centre to the left/right track edge (< 0 past it) |
| 13, 14 | `wall_left`, `wall_right` | 0.1 | m | car centre to the left/right wall's face; 50 if none or further |
| 15 | `off_track` | 1 | | all four wheels past the track limits (the game's rule: the lap is invalid) |
| 16 | `in_pit_lane` | 1 | | the car's centre is in the pit lane: on its road and off the track's (the game's PIT LANE rule: the lap is invalid) |
| 17, 18 | `pit_left`, `pit_right` | 1 | | at the car's track sample, the pit lane is open to the track on that side: leaving the road there is entering it (below) |
| 19-34 | `wheel_{fl,fr,rl,rr}_{asphalt,kerb,grass,gravel}` | 1 | | surface under each wheel, one-hot per wheel |
| 35-38 | `wheel_{fl,fr,rl,rr}_out` | 1 | | wheel past the track limit |
| 39-42 | `wheel_{fl,fr,rl,rr}_slip` | 1 | | combined slip, 1 = at the tyre's grip peak whichever way it slips (cornering, braking, wheelspin; capped at 4) |
| 43 | `gear` | 0.125 | | -1 reverse, 1.. forward |
| 44 | `rpm` | 1 | share | rpm over the redline |
| 45, 46 | `throttle`, `brake` | 1 | | what the engine got in the last tick, after the aids |
| 47 | `steer` | 1 | | front road-wheel angle over the full lock (+ = left) |
| 48, 49 | `tc_active`, `abs_active` | 1 | | the aid cut in during the last tick |
| 50, 51 | `target_steer`, `target_pedal` | 1 | | command the actions ask for (delta mode: integrated) |
| 52, 53 | `cmd_steer`, `cmd_pedal` | 1 | | command sent in the last tick, after the slew limits |
| 54, 55 | `prev_steer`, `prev_pedal` | 1 | | last action as given (delta mode: the deltas) |
| 56 | `wall_contact` | 1 | | touched a wall during the last step |
| 57 | `wall_hit` | 0.1 | m/s | hardest impact speed into a wall during the last step |
| 58 | `look_reach` | 1/400 | m | reach R of the look-ahead: `lookMinM + lookSecs x max(speed_fwd, 0)` (default 40 m + 4 s) |
| 59 + 6k ... | `look{k}_curv`, `_wl`, `_wr`, `_sin`, `_cos`, `_pit` | 1, 0.1, 0.1, 1, 1, 1 | | sample k = 0..15 at R x ((k+1)/16)^1.5 along the centreline: curvature as sign(c) sqrt(abs(c) x 50 m) (+ = left; a 50 m radius reads 1), half-widths to the left/right edge (m), sin/cos of the bearing of that centreline point from the car's nose (+ = left), and the pit lane open there: +1 on the left, -1 on the right, 0 none (at the nearer track sample) |
| 155 | `tyres_present` | 1 | | the car models tyre temperatures (lcf1, lcgt3) |
| 156-159 | `tyre_{fl,fr,rl,rr}_temp` | 1 | | carcass temperature, 0 at the bottom of that axle's working window, 1 at its top (0 if absent) |
| 160, 161 | `battery_present`, `battery` | 1 | | hybrid battery (lcf1 only), charge 0..1 |
| 162, 163 | `flaps_fitted`, `flaps_open` | 1 | | movable wings (lcf1 only: they open by themselves on straights) |

**Where the pit lane is open** (`pit_left`, `pit_right`, `look{k}_pit`; `src/ai/pitOpen.ts`): a per-sample flag for
each side, built once per circuit by asking the timing's own test. Sample i, side L / R is set if any of 35 points
round it (0, 0.5 and 1 m either way along the track, times 0.05, 0.5, 1, 1.5, 2, 2.5 and 3 m past that edge, all in
front of the track's barrier) is in the pit lane (`inPitLane`) on its open stretch (not between the pit wall's nose
and tail, where the lane is behind the wall and `wall_left` / `wall_right` read the wall's face), then grown by one
sample (about 2 m) each way, for the lane's road beginning between those points at a stretch's ends. Checked at every
circuit against a far finer search (every 0.25 m along the lap, 0.1 m steps out to 4 m past the edge and 0.25 m to 12
m, `test/ai-pit.test.ts`): wherever a car's centre in front of the barrier would be in the open lane, its nearest track
sample has that side set. Flagged per lap: 42 m (Monaco) to 308 m (Hungaroring, whose exit road runs beside the
track for 200 m), on the lane's side only; Melbourne 132 m, on the right (4762-4832 m and 86-148 m from the line).

The function is `observe()` in `src/ai/observation.ts`: it reads the car only through the game's `Vehicle`
interface and the track's arrays, so the browser can build the same vector for a trained policy. `OBS_VERSION`
(sent in HELLO and READY) changes whenever the layout, a scale or what an element measures changes. Version 2: the
wheel slips are 1 at the tyre's grip peak in braking and wheelspin too (on the LibreCorsa-engine cars they were measured
against the lateral peak, which the longitudinal one comes before) and on the drift car (whose 1 was 0.15 rad of slip
angle, about half its tyres' peak). Version 3: the pit lane (`in_pit_lane`, `pit_left`, `pit_right` after `off_track`,
and `look{k}_pit` after each sample's `_cos`), so every element from `wheel_fl_asphalt` on has moved; 164 values
(version 2 had 145, `65 + 5 x obs.lookahead`).

### Reward

Per step, the sum of these terms (each also reported in `info`, so shaping can be analysed):

| term | default | definition |
|---|---|---|
| `reward_progress` | `progress` = 1 per m | centreline progress (m) during the step, from `projectOnTrack` every tick: the lap wrap is handled, each tick's progress is capped at 1.5 x the distance the car can have covered (+5 cm), so a projection that jumps to another part of the track earns nothing, and **ticks with all four wheels past the track limits earn nothing** (the game's track-limit rule from `src/timing.ts`), **nor do ticks in the pit lane** (its PIT LANE rule): cutting does not pay |
| `reward_wall` | `wallHit` = 1 per m/s, `wallContact` = 0.2 | -(wallHit x hardest impact speed into a wall during the step + wallContact if any wall contact) |
| `reward_off_track` | `offTrack` = 5 per s | -(offTrack x seconds of the step with all four wheels off) |
| `reward_pit_lane` | `pitLane` = 5 per s | -(pitLane x seconds of the step in the pit lane) |
| `reward_smooth` | `steerSmooth` = 0, `pedalSmooth` = 0 | -(steerSmooth x (steer - previous steer)^2 + pedalSmooth x (pedal - previous pedal)^2), on the actions as given |
| `reward_terminal` | `terminal` = 20 | -terminal on a termination (never on a truncation) |

Rewards are in metres of progress: about 3-4.5 per step at racing speed (20 Hz), a lap about its length (5.3 k at
Melbourne). Scale them in the trainer if needed. Impact speed is the contact point's velocity into the wall's normal
as the tick began: about 14 for a 30 m/s car meeting a wall at 30 deg, near 0 for a scrape along it.

### Episode ends

`terminated` (a true terminal: do not bootstrap) and `truncated` (time out: bootstrap from the final observation) are
separate. `info.end_reason` says why: 0 none, 1 flipped, 2 wrong_way, 3 stuck, 4 wall, 5 time_limit, 6 lap_done.
They are checked after every physics tick; an ending tick ends the step there (a shorter last step).

| reason | kind | rule (config `termination.*`, 0 turns a rule off) |
|---|---|---|
| flipped | terminated | the game's own reset test (`needsReset` in `src/sim.ts`): fell through the world, on its roof and slower than 2 m/s, on its side for 1.5 s, or (LibreCorsa) the engine state went non-finite |
| wrong_way | terminated | `wrongWayM` = 30: the car is 30 m of centreline behind the furthest point it reached this episode |
| stuck | terminated | `stuckSecs` = 3 at below `stuckSpeed` = 1 m/s (forward speed, either direction) |
| wall | terminated | `wallImpactMs` = 0 (off): a wall hit at least this fast (m/s) |
| time_limit | truncated | `episodeSecs` = 90 of sim time (`evalSecs` = 300 in evaluation) |
| lap_done | truncated | evaluation episodes only: the first timed lap is complete |

Laps are continuous: crossing the line does not end a training episode. The automatic restarts the game's `Session`
does are never used by the environment.

### Resets

Each reset builds a **fresh car** on the chosen circuit: a new engine instance for the LibreCorsa cars (full
battery and fuel, brake discs at their start temperature, tyres at the heat of a lap: `LcSpec.warmTyres`, carcass
about 91 °C on the F1 and 64 / 67 °C front / rear on the GT3, pressures to match; no lap energy used), a new Rapier body for the drift
car; lap timing cleared (no best times either: the worker keeps none); every controller state (targets, slew
state, previous action, stuck timer, progress) zeroed. The physics world of a circuit (walls) is built once and kept
for the next episode there (`cacheSessions` = 2 circuits per environment, ~10 MB each). Episodes are independent of
what ran before (checked: an episode is bit-identical whether or not other episodes ran first).

- **Random start** (default): circuit and car drawn uniformly from `reset.tracks` / `reset.cars`; position s uniform
  over the lap; lateral offset uniform in `latFrac` x [-(right half-width - latMarginM), +(left half-width -
  latMarginM)] (defaults 0.6, 1.5 m); heading error uniform in +-`headingMax` (0.1 rad), rolling along the car's
  nose; speed = uniform(`speedFrac` = [0.3, 1]) x the autopilot's planned speed at that point (`buildSpeedProfile`).
  For the LibreCorsa cars the engine settles the car at that speed first (its rolling start): a few ms.
- **Flying start**: the game's own start (the start spot `TrackDef.startBack` metres before the line, on the
  straight before the last corners, rolling at the car's `TrackDef.flying` speed; the run-up to the line takes
  8–20 s), chosen with probability `flyingProb` (0.1), or always with `start: 'flying'`.
- **Evaluation** (`eval: true`): the flying start, and the episode ends (truncated, `lap_done`) when the first timed
  lap is complete; `info` then has the game's lap time, validity and sector times. The baselines are the autopilot's
  pinned laps (`test/laps.ts`, e.g. lcf1 Melbourne 116.548 s, lcgt3 133.860 s, drift 157.515 s; every circuit in its
  `CALENDAR`).

Random numbers come from a seeded generator per environment (sfc32); there is no `Math.random` in the environment
or the physics. The same seed and actions give bit-identical observations, rewards and info, in any process (tested
through the worker against an in-process run).

### Info

Per environment per step, `F` = 30 float64 values (the order is `infoFields` in HELLO/READY; fields added later go at
the end, so the indices of the older ones stay):

| index | field | |
|---|---|---|
| 0-4 | `reward_progress`, `reward_wall`, `reward_off_track`, `reward_smooth`, `reward_terminal` | the reward's terms (with `reward_pit_lane`, 29, they sum to the reward) |
| 5 | `progress_m` | centreline progress this step (m), on or off the track |
| 6 | `episode_progress_m` | since the episode began |
| 7 | `episode_time` | sim seconds since the episode began |
| 8 | `lap_s` | where the car is on the lap (m from the line) |
| 9 | `lat` | m left of the centreline |
| 10 | `speed` | forward speed (m/s) |
| 11 | `off_track_time` | s of this step with all four wheels off |
| 12 | `wall_hit` | hardest impact speed into a wall this step (m/s) |
| 13 | `wall_contact` | 1 if the car touched a wall this step |
| 14 | `end_reason` | see Episode ends |
| 15 | `lap_done` | 1 if a timed lap was completed this step |
| 16 | `lap_time` | its time (s), from the game's timing (crossings interpolated within the tick), else NaN |
| 17 | `lap_valid` | 1 valid, 0 invalid (track limits or wrong way, the game's rules), NaN if no lap |
| 18-20 | `sector1`-`sector3` | that lap's sector times (s), else NaN |
| 21 | `laps` | timed laps completed this episode (the first starts at the first line crossing) |
| 22 | `lap_valid_now` | whether the lap under way is still valid (1/0), NaN before the first crossing |
| 23, 24 | `autopilot_steer`, `autopilot_pedal` | the autopilot's equivalent action on an autopilot step, else NaN |
| 25 | `track_index` | index into `tracks` (HELLO) |
| 26 | `car_index` | index into `cars` (HELLO): 0 lcf1, 1 lcgt3, 2 drift |
| 27 | `episode` | episodes begun by this environment so far (1 for the first) |
| 28 | `pit_lane_time` | s of this step in the pit lane (the PIT LANE rule's test after each tick: when it is > 0 with a lap under way, that lap is deleted in this step) |
| 29 | `reward_pit_lane` | the reward's pit lane term |

## Wire protocol (version 1)

All integers and floats are **little-endian**. Both directions use the same framing:

    u32 length            bytes that follow (the payload)
    payload:
      u8  type
      u8  0, 0, 0
      u32 arg             JSON messages: the JSON's byte length; binary messages: N (number of environments)
      ... body            from payload offset 8

Offsets below are from the start of the payload. Every array starts at an offset that is a multiple of its element
size (float64 blocks at multiples of 8: `pad8(x) = (x + 7) & ~7`), so once a payload is in a buffer of its own its
arrays can be viewed in place (numpy `frombuffer(payload, dtype, count, offset)`). JSON bodies are UTF-8.

The worker writes HELLO as soon as it starts, then answers each request with exactly one message, in order. stdout
carries nothing else; logs go to stderr. A failed request gets ERROR instead of its reply and the worker carries on.
Closing the worker's stdin ends it too.

| type | name | direction | body |
|---|---|---|---|
| 0x01 | HELLO | worker -> client, on start | JSON (below) |
| 0x02 | INIT | client -> worker | JSON `{ "numEnvs": N, "seed": s, "config": {...} }` |
| 0x03 | READY | worker -> client | JSON (below) |
| 0x10 | RESET | client -> worker | JSON reset options (below); an empty body or `{}` resets all with the defaults |
| 0x11 | RESET_OK | worker -> client | binary (below) |
| 0x20 | STEP | client -> worker | arg N; body float32[N x 2] actions, env-major: steer0, pedal0, steer1, ... |
| 0x21 | STEP_OK | worker -> client | binary (below) |
| 0x7E | ERROR | worker -> client | JSON `{ "error": "message" }` |
| 0x7F | CLOSE | client -> worker | none; the worker exits (status 0) without replying |

**HELLO**: `{ protocol: 1, game: { commit, dirty, builtAt }, physicsHz: 120, tracks: [24 ids], cars: ["lcf1",
"lcgt3", "drift"], defaultConfig: {...}, infoFields: [...], endReasons: [...], obsVersion }`. Check `protocol` and
`game.commit`/`dirty` (the build the trainer trained against).

**INIT**: creates N environments (1 to 4096; send INIT again to replace them). `config` is a partial config merged
over the defaults (unknown keys are an error). Environment k draws its random numbers from seed `s + k`. Every
circuit in `config.reset.tracks` is built here (tens of ms each, once per process).

**READY**: `{ protocol, numEnvs, seed, config (the full effective config), obsSize, obsVersion, obsClip: 10,
obsSpec: [{ name, index, scale, unit, desc, transform? }], actionSize: 2, actionSpec: [{ name, index, low, high,
desc }], infoFields, endReasons }`.

**RESET** options: an object applies to every environment, an array of N objects (or nulls) to each in turn. Fields,
all optional: `seed` (reseed first; with one object for all, environment k gets `seed + k`), `track`, `car`
(instead of drawing), `start` (`"random"` / `"flying"`), `eval` (true / false), and for a random start the pose
`s` (m along the lap), `lat` (m, + = left), `heading` (rad, + = left), `speed` (m/s). `track`, `car`, `start` and
`eval` stay in force for every later automatic reset of that environment until a RESET changes them (so an
evaluation worker sends `{"eval": true, "car": "lcf1", "track": "melbourne"}` once); `seed` and the pose apply to
this reset only. A track outside `config.reset.tracks` is loaded on first use.

**RESET_OK** (arg N):

| offset | type | content |
|---|---|---|
| 8 | u32 x 4 | N, D (obsSize), F (info fields), 0 |
| 24 | float32[N x D] | first observation of each environment |
| pad8(24 + 4ND) | float64[N x F] | info of each (the reward terms 0, lap fields NaN) |

**STEP_OK** (arg N), with K = the number of environments whose episode ended in this step:

| offset | type | content |
|---|---|---|
| 8 | u32 x 4 | N, D, F, K |
| oObs = 24 | float32[N x D] | observation; for an environment whose episode ended, the **first observation of its new episode** |
| oRew = oObs + 4ND | float32[N] | reward of this step |
| oTerm = oRew + 4N | u8[N] | terminated (0/1) |
| oTrunc = oTerm + N | u8[N] | truncated (0/1) |
| oInfo = pad8(oTrunc + N) | float64[N x F] | info of this step (for an ended episode: of its last step) |
| oDone = oInfo + 8NF | u32[K] | indices of the environments whose episode ended, ascending |
| oFinal = pad8(oDone + 4K) | float32[K x D] | their final observations (the state the last step ended in), in the order of oDone |

The length is `oFinal + 4KD`. An environment whose episode ends is reset at once (automatic reset, with its sticky
options): as in Gymnasium's vector environments, store `(obs_before, action, reward, final_obs, terminated)` for it,
and continue from the new `obs`.

### Example

A session with one environment (sizes for the default config: D = 164, F = 30). Bytes in hex; `len` is the u32
length prefix, `hdr` the payload's first 8 bytes (type, 3 zeros, arg).

    worker: len | hdr 01 000000 <json bytes> | HELLO {"protocol":1,"game":{"commit":"9e26...","dirty":false,...},...}
    client: len | hdr 02 000000 <json bytes> | INIT {"numEnvs":1,"seed":7,"config":{"reset":{"tracks":["melbourne"],"cars":["lcf1"]}}}
    worker: len | hdr 03 000000 <json bytes> | READY {..., "obsSize":164, "obsSpec":[{"name":"car_lcf1","index":0,"scale":1,...}, ...]}
    client: len | hdr 10 000000 <json bytes> | RESET {"eval":true}
    worker: len=920 | hdr 11 000000 01000000 | u32 1, 164, 30, 0 at 8 | obs f32[164] at 24 | info f64[30] at 680
    client: len=16  | hdr 20 000000 01000000 | f32 0.0, f32 1.0 (steer 0, full throttle)
    worker: len=928 | hdr 21 000000 01000000 | u32 1, 164, 30, 0 | obs at 24 | reward f32 at 680 |
                      terminated u8 at 684 | truncated u8 at 685 | info f64[30] at 688 | (K = 0: nothing after 928)
    ...               about 2,370 steps later, in evaluation mode:
    worker: len=1592 | hdr 21 ... | K = 1 | truncated[0] = 1 | info: end_reason 6 (lap_done), lap_time, lap_valid,
                      sectors | done u32 at 928 = 0 | final obs f32[164] at 936 | obs at 24: the next lap's start
    client: len=8   | hdr 7f 000000 00000000 | CLOSE

`ai/client.mjs` (Node) and `ai/client.py` (Python, `struct`/`array` only) implement all of this in about 100 lines
each; `test/ai-worker.test.ts` runs the built worker against the in-process environments, bit for bit.

## Configuration

Every field, with its default (`DEFAULT_CONFIG` in `src/ai/config.ts`, also sent in HELLO):

| field | default | |
|---|---|---|
| `actionHz` | 20 | policy steps per sim second; must divide 120 |
| `actionMode` | `"absolute"` | or `"delta"` |
| `deltaScale` | [0.25, 0.5] | delta mode: command change per step at action 1 (steer, pedal) |
| `steerRate` | 3 | steering slew limit, full locks per second |
| `pedalRate` | 0 | pedal axis slew limit per second (0: none) |
| `tc` | true | traction control (ABS is always on) |
| `episodeSecs` | 90 | time limit (truncation), sim seconds |
| `evalSecs` | 300 | time limit of evaluation episodes |
| `cacheSessions` | 2 | circuits' physics worlds kept per environment (performance only) |
| `obs.lookahead` | 16 | look-ahead samples (changes the observation size) |
| `obs.lookMinM`, `obs.lookSecs` | 40, 4 | look-ahead reach: lookMinM + lookSecs x forward speed |
| `obs.lookPow` | 1.5 | sample spacing exponent (> 1: denser near the car) |
| `reward.progress` | 1 | per metre of centreline progress on the track (not off it, not in the pit lane) |
| `reward.wallHit` | 1 | per m/s of the step's hardest wall impact |
| `reward.wallContact` | 0.2 | per step touching a wall |
| `reward.offTrack` | 5 | per second with all four wheels off |
| `reward.pitLane` | 5 | per second in the pit lane |
| `reward.steerSmooth`, `reward.pedalSmooth` | 0, 0 | x squared change of the action |
| `reward.terminal` | 20 | subtracted on a termination |
| `termination.wrongWayM` | 30 | m behind the furthest point reached (0: off) |
| `termination.stuckSecs`, `termination.stuckSpeed` | 3, 1 | s below that speed (m/s) (0 s: off) |
| `termination.wallImpactMs` | 0 | terminate on a wall hit at least this fast (0: off) |
| `reset.tracks` | `["melbourne"]` | circuits to draw from (ids as in HELLO `tracks`) |
| `reset.cars` | `["lcf1"]` | cars to draw from |
| `reset.start` | `"random"` | or `"flying"` |
| `reset.flyingProb` | 0.1 | random start mode: chance of the flying start instead |
| `reset.speedFrac` | [0.3, 1] | random start speed, x the autopilot's planned speed there |
| `reset.latFrac`, `reset.latMarginM` | 0.6, 1.5 | random lateral offset (see Resets) |
| `reset.headingMax` | 0.1 | random heading error, rad |
| `reset.eval` | false | evaluation episodes |

## Throughput

Measured with `node ai/bench.mjs` on an AMD Ryzen 5 5600G (6 cores, 12 threads, WSL2), Node 26, autopilot driving
(no crashes, so no reset cost in the step figures):

| | env steps/s, one process | ms per env step (6 ticks) |
|---|---|---|
| lcf1 | 600-620 | 1.6 |
| lcgt3 | 620-680 | 1.5 |
| drift | 270-300 | 3.3-3.7 |

- Resets: random start 3-8 ms (LibreCorsa cars: the engine's rolling-start settle; drift car: 3 ms), flying start
  3-7 ms; a reset onto a circuit whose world is not cached builds it: about 40 ms (up to 100).
- Scaling, 4 environments per process with the three cars mixed: 1 process 370 steps/s, 2: 690, 4: 1060, 6: 1240,
  8: 1060, 12: 880. Throughput peaks at one process per physical core; hyperthreads do not help.
- Where the time goes: the LibreCorsa cars spend almost all of it in the vendored engine (500 Hz tyre, suspension
  and drivetrain solve, about 70 us per engine step, 4-5 steps per tick); the environment itself (projection,
  observation, reward) is about 1%. The drift car spends about 80% in Rapier's `world.step`, almost all of it on the
  circuit's 5,300 static wall colliders and the ground box (a world with the walls and no car costs 0.43 ms a step).
  Making that cheaper means changing how walls are built, which is a physics change, so it was not done.
- Message overhead is negligible next to stepping (a step's reply is about 0.9 kB per environment).

## Trained policies in the game

A policy trained by `ai/rl/` drives the player's car with `?autopilot=rl` in the URL (as `?autopilot` does the
built-in one: it also skips the menu). The game drives it exactly as the environment does: the same code takes the
action to the car (`src/ai/control.ts` `Controller`: targets, slew limits, steering as a share of the lock through
`DriveInput.steerAngle`, automatic gears) and builds the observation (projection, `observe()`, the commands and the
last step's wall contact from `WallSensor`), in `RaceEnv` and in `src/ai/policyDriver.ts` `PolicyDriver`.

**Export.** `ai/rl/export_web.py` turns a run's `.npz` into the web policy file:

    cd ai/rl && .venv/bin/python export_web.py --run runs/<name> [--policy best.npz] --out ../../public/ai/<file>.bin [--note ...]

It starts one env worker (`build/env/worker.mjs`, or `--worker`) with the run's env config (its `config.json` `env`,
with the env's penalties off when the run used the trainer's reward, as `train.py` runs it) to read the effective
config and `obsVersion` from READY; it records the evaluation that produced the policy (for `best.npz`, the run's last
improving line of `eval.jsonl`). Layout, little-endian:

| offset | type | content |
|---|---|---|
| 0 | 4 bytes | `FRPW` |
| 4 | u32 | J: the JSON's byte length |
| 8 | J bytes | UTF-8 JSON (below) |
| 8 + J | zeros | to a multiple of 4 |
| `(8 + J + 3) & ~3` | float32[] | the arrays, back to back; each at `arrays[name].offset` floats from here |

The JSON: `format` (`"fast-roads-policy-web"`), `version` 1, `obs_dim`, `act_dim`, `obs_clip`, `obsVersion`, `ops`,
`output` and the optional `act_scale` (as in the `.npz`: `ai/rl/policy_np.py`; the action is
`clamp(act_scale x tanh(mean), -1, 1)`, the scale 1 each if absent), `arrays` (`{name: {offset, shape}}`: `obs_mean`,
`obs_scale`, then the weights; linear weights `[in, out]`), `env` (the full effective environment config:
`actionHz`, `actionMode`, `deltaScale`, `steerRate`, `pedalRate`, `tc`, `obs` are what the game drives with),
`trained` (`cars`, `tracks`), `provenance` (free-form: run, policy file and its sha256, actor, env steps, the
evaluated laps, the worker's build, a note).

**In the game.** `public/ai/policies.json` names the files, per car id: `{ "lcf1": { "default": "lcf1.bin",
"tracks": { "melbourne": "lcf1-melbourne.bin" } } }` (it is `{}` while no policy is trained on the current
observation version; the tests that drive the game's own policy skip then). The circuit's specialist is used, else the car's default, else
the built-in autopilot drives (with a console warning); another car loads its own. `src/ai/policy.ts` parses the file
(`parsePolicy`) and refuses one whose `obsVersion` is not the game's `OBS_VERSION`, whose `obs_dim` is not
`observationSpec(env.obs)`'s length, or that lacks a control field; `Policy.run` computes the action (float32 between
ops, float64 sums: actions agree with numpy's to about 1e-6; about 0.1 ms for a 256 x 256 MLP, 0.5 ms for a 256-wide
SimBa actor). The files are fetched on use and are not in the service worker's precache. `window.__game`:
`setAutopilot('rl')` (resolves true once a policy drives), `policy` (its file and metadata), `simulate(s, 'rl')`.

`PolicyDriver` gives the input for every physics tick: every `120 / actionHz` ticks it observes the car and asks the
policy; it starts afresh (an episode's first step: commands zeroed) when the car is put at the start spot
(`Session.resets`), replaced (another car), or a tick went by without it (the built-in autopilot drove a pit stop,
the player drove). From the same start the game's `Session` and `RaceEnv` give bit-identical observations, actions
and cars (`test/ai-policy-driver.test.ts`), and the game's start spot and restart are the environment's flying start
(a fresh engine: full battery, tyres at the heat of a lap). What can still make a policy drive differently than in
its training:

- **Inference arithmetic.** The trainer evaluates with torch, `policy_np.py` with numpy, the game in TypeScript: the
  actions differ by about 1e-6, and over a lap that moves the line. One policy (`mel_f1_a` at 1.2 M env steps): 101.779
  s (torch), 102.035 s (numpy), 101.744 s (the game, Node). A policy that only just keeps inside the track limits can
  have its lap deleted in one and not another (the `smoke` run's: 103.053 s valid with torch, 103.544 s invalid with
  numpy, 103.111 s invalid in the game).
- **Browser and Node.** The browser runs the same ticks, but its JavaScript engine's `Math.atan2`, `sin`, `cos`,
  `tanh`, `exp` can differ from Node's in the last bit (Chromium 156 against Node 26: atan2 on about 12% of inputs,
  sin 3%, tanh rarely). The built-in autopilot's laps still agree to the millisecond; a policy's do not have to (the
  `mel_f1_a` policy: 102.100 s, invalid, in headless Chromium).
- **Settings the environment fixes.** Traction control is the game's TC setting (the console warns if it is not
  what the policy was trained with: `env.tc`); gears are always automatic for the policy (`autoGears`), whatever the
  gearbox setting. Race conditions (a room's weather and wear, `?wear` / `?wet`) are outside training (the time trial's
  conditions only).
- **Multiplayer.** Other cars (contacts, proxies) were never in training; a pit stop is driven by the built-in
  autopilot.

