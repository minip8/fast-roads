# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow

- Commit after each change. Use a short imperative subject line and a brief body explaining what changed and why,
  matching the existing history.
- Keep `README.md` in sync when controls, settings, cars or physics behaviour change (it documents all of them).

## Running

Vite + TypeScript (strict), no framework. three.js and Rapier (`@dimforge/rapier3d-compat`) are npm dependencies
pinned to exact versions. The production build (`vite.config.ts`) puts three.js and Rapier in their own chunks and
swaps Rapier's inline base64 WebAssembly for the identical `.wasm` file it ships (the build fails if they differ);
dev and the tests use the inline copy.

    npm install
    npm run dev         # dev server; ?autopilot in the URL skips the menu and lets the built-in driver lap
    npm run typecheck   # tsc for src/, then for test/ (only test/ gets Node types)
    npm test            # Vitest, headless physics (~35 s: the test files run in parallel)
    npx vitest run test/handling.test.ts -t 'F1'   # one file / one test by name
    npm run build       # typecheck + static build in dist/ (base './'); npm run preview serves it
    node scripts/cars/convert.mjs gt3 <source.glb> <textures dir>   # remake a car model (sources: see its header)

Run `npm run typecheck` and `npm test` before committing.

## Testing

- Tests run the real simulation in Node: `test/harness.ts` `session(carId, { tc, walls })` builds the track and the game's
  own `Session` (`src/sim.ts`: Rapier world, walls, car at the start spot, timing) with no rendering. The car starts
  at rest there; `session(carId, { flying: true })` starts it as the game does, at flying-lap speed. `drive(seconds,
  driver?, until?)` calls `Session.tick` with the autopilot or a `(car, simTime) => DriveInput` function, exactly as
  the game loop does, including the automatic resets; `until` stops early once the test has what it measures.
- The simulation is deterministic, and Node and the browser agree to the millisecond. `test/laps.ts` pins
  autopilot lap times from the game's flying start (F1 1:59.159, drift car 157.514 s with TC on, 157.491 s off), so
  any physics or tuning change shows up there. When a change is intended, check the handling still makes sense, then
  update the expected times. It also pins the autopilot at Silverstone (F1 129.121 s, drift car 169.794 s), the GT3
  at both circuits (Melbourne 130.795 s, Silverstone 141.453 s) and the two LibreCorsa-engine cars at both (`lcgt3`
  133.917 s and 144.234 s, `lcf1` 116.317 s and 123.798 s). Each lap test also checks that the car passes the start
  spot at the end of the lap within 2 km/h of its `TrackDef.flying` speed; `test/start.test.ts` checks the flying
  start and restart themselves. Each lap is run by its own `laps-*.test.ts` file so the eleven (about
  12–35 s each) run in parallel. `session(carId, { track })` picks the
  circuit (Melbourne by default).
- `test/handling.test.ts` holds loose-bound checks of tuning intent: the drift car's brake-and-turn kick, a stable
  F1. `car.forceSurface = S_ASPHALT` keeps manoeuvres off grass. Keep them short (about 1–2 s after the manoeuvre):
  the start straight is walled (`walls: false` removes the barriers for manoeuvres that need the room).
- `test/gt3.test.ts` holds the GT3 to the car it is taken from: LibreCorsa's published cornering, braking and
  full-throttle g by speed and its understeer gradient (its `docs/physics/README.md`), measured here with the same
  manoeuvres on open asphalt (`rolling(v0)` starts the car at speed). Retune the GT3 against that table, not by feel.
- LibreCorsa-engine cars (`src/lc/`) have three layers of tests: `test/lc-engine.test.ts` (the vendored engine alone
  on flat ground; `test/lc-gt3-reference.ts` ports LibreCorsa's own GT3 measurement and must match upstream's
  numbers to four decimals, so any accidental change to `src/lc/vendor/` shows up), `test/lc-driver.ts` (ABS, TC,
  keyboard and analog steering through `src/lc/driver.ts`, one file per car) and `test/lc-car.ts` (the cars in the
  game's `Session`: start spot, walls, surfaces, placement and restarts, shifts and reverse, rendering, the F1's flaps and lap energy).
  Tests that reach into our own physics use `ourCar(car)` / `ourSpec(spec)` from the harness, which fail for a car
  on another engine.
- In the browser, `window.__game` exposes `simulate(seconds, driver, probeSecs)`, `car` (a getter: the car object is
  replaced when you switch cars), `simTime`, `session`, `timing`, `track`, `input`, `setSetting(key, value)` and
  `setAutopilot` and `stage` (renderer, scene, camera; the `GameHook` type in `main.ts`). Use it for checks that need the page (menu, HUD, settings), e.g.
  from headless Chromium.

## Architecture (`src/`)

`index.html` is just the page markup (HUD, menu); styles are in `src/style.css`. Modules:
- `boot.ts`: the entry point; checks for WebAssembly/WebGL 2, then `import('./main')` and calls `main()`. Startup
  failures (missing feature, failed chunk or wasm download, other errors) go to `startup.ts`, which shows a message
  with a retry button in `#loadState`. The build preloads the dynamically imported chunks from `index.html`.
- `sw.js`: service worker template (plain JS). The build writes `dist/sw.js` with the list of every output file to
  precache; `boot.ts` registers it in production only. `index.html` is network-first, everything else cache-first.
  The car models are not precached: the game fetches `model.glb?v=<content hash>` (`__CAR_MODELS__`, defined in
  `vite.config.ts`) and the worker keeps each one the first time, in a cache that outlives deploys.
  `public/` holds the icon and web app manifest.
- `config.ts`: constants, surfaces, collision groups
- `util.ts`: math and formatting helpers
- `cars.ts`: car specs (`CarSpec`)
- `vehicle.ts`: `Vehicle`, a drivable car as the rest of the game sees it (session, timing, camera, HUD, dust,
  sound, autopilot), whichever engine drives it, and `DriveInput`
- `car.ts`: our car physics (`Car implements Vehicle`)
- `lc/`: cars on LibreCorsa's physics engine (see **LibreCorsa engine** below)
- `sim.ts`: `stepPhysics` (one physics tick; replaces non-finite input, which would abort Rapier) and `Session`
  (world, walls, car at the start spot, timing; `tick`, `restart`, `setCar`), shared by the game and tests.
  `restart` is the only reset (R / Enter, the menu, a stuck autopilot, a car on its roof): the car goes to
  `TrackDef.startBack` metres before the line, rolling at its `TrackDef.flying` speed (`Vehicle.placeAt(s, lat,
  speed)`), and the lap under way is dropped
- `carMeshes.ts`: car bodies, static parts merged per material, each with a seated driver and steering wheel
  (`Cockpit`: the Driver camera's eye, the helmet it hides, and `poseCockpit`, which both cars' `render` call to turn
  the wheel and arms). Paint and metal reflect the environment map that
  `stage.ts` hands over with `setCarEnvironment` before any car is built. `CarMesh.dispose()` frees a body on car
  switch. The GT3s (`GT3_MODEL`, `LC_GT3_MODEL`) are 3D models (`public/cars/<id>/model.glb` + `LICENSE.md`,
  CC BY-NC-SA: credits in README): the procedural body is built first (and is all the tests get), and when
  `carModels.ts` (GLTFLoader + meshopt, browser only, installed by `stage.ts`) has loaded the file, the body,
  wheels (`spinner` moves to the model's wheel centre), calipers, steering wheel and brake light are swapped in
  place, so `mesh.cockpit` / `mesh.brakeLight` change: read them at use. A loaded model is cached and shared by
  every car built from it (`userData.shared`: never disposed). `scripts/cars/convert.mjs` makes the files from the
  Sketchfab downloads (part names and `extras.frame` documented there); `test/carModels.test.ts` checks them
  against the specs' axles.
- `tracks.ts`: the circuits (`TRACKS`, `TrackDef`): CSV, names, best-times key, start spot and each car's flying-lap speed there, scenery placement
- `track.ts`: track geometry and colliders (`Track`)
- `trackMeshes.ts`, `textures.ts`, `scenery.ts`, `brakeMarkers.ts`: visuals; `batch.ts`: `Batch`, which merges many
  static parts into one mesh per material (grandstands, pit, gantry, brake boards, car bodies)
- `audio.ts`: `EngineAudio`, the AudioContext's lifecycle (created on the first gesture, suspended while muted or
  hidden); `audioGraph.ts`: `SoundGraph`, every sound node, built once, with `update()` moving only parameters.
  It reads the car through the `AudioCar` interface and each car's `spec.sound` (`EngineVoice`). A voice with
  `loops` (only the GT3s') plays synthesised loop buffers instead of the oscillators: `engineLoops.ts` makes them
  in plain JS (exhaust pulses per cylinder in the firing order, a waveguide pipe per bank, saturation; whole engine
  cycles, so they loop seamlessly), one per `update()` the first time the voice is used (the oscillators play
  meanwhile), and `LoopPlayer` crossfades them by rpm and throttle and adds overrun pops and gear whine.
  `test/engineLoops.test.ts` checks the loops (seams, level, cross-plane spectrum, brighter on load).
- `timing.ts`, `input.ts`, `dust.ts`, `autopilot.ts`
- `stage.ts`: renderer, scene, lights, sky, shadow-following sun, static track visuals (`buildStage`)
- `camera.ts`: `CameraRig` (camera modes)
- `settings.ts`: setting types, menu rows, defaults, load/save
- `menu.ts`: `Menu`, which talks to `main.ts` only through the `MenuHost` callbacks
- `hud.ts`, `minimap.ts`: in-game HUD (`Hud.update` runs every frame but writes only text/classes/styles that
  changed); `dom.ts`: `$` element lookup
- `main.ts`: wires it together and owns game state (the `Session`, `started`/`paused`/autopilot, the
  `applySetting` table, hotkeys, the `window.__game` hook (typed `GameHook`), the frame loop)

- **Track data**: `tracks/*.csv` (TUM racetrack-database centreline + widths, first row at the start/finish line,
  in racing direction), imported into `tracks.ts` with Vite's `?raw` suffix; `parseCSV` skips `#` comment lines.
  A new circuit is a CSV plus a `TRACKS` entry: the Circuit menu row, labels, best-times keys (`TrackDef.storeKey` +
  the car's `storeKey` suffix) and scenery follow from it. Check the start straight (start spot `startBack`, pit
  building and stands ranges must sit on it), that the autopilot laps it cleanly, and how it looks. A new circuit or car also needs its `flying` speeds (km/h at
  the start spot): run the lap with a guess, and take the speed the lap test reports there at the end of the lap. Everything is
  built once at startup for `settings.track`, so changing the Circuit setting saves it and reloads the page.
  `buildTrack` turns it into a closed spline sampled every ~2 m (arrays `X, Z, TX, TZ, NX, NZ, K, S, WL, WR`, kerb/
  gravel/barrier offsets). Almost everything works in track coordinates `(s, lat)` via `projectOnTrack` / `pointAt`.
- **Car specs (`CARS`)**: every physics, engine, gearbox, steering, collider, camera, sound and autopilot number for
  each car (`f1`, `drift`, `gt3`), plus its mesh builder, its engine voice (`sound`, an `EngineVoice` from `audioGraph.ts`)
  and its lap-time `storeKey`. The `Car` class reads only `this.spec`, so a new car is a new spec entry
  (`test/cars.test.ts` checks each spec fits the menu, gearbox, mesh and autopilot). Behaviour toggled per car uses
  neutral defaults on the F1 (e.g. `brakeKick: 0`, `brakeGrip: 1`, `driveGrip: 1`, `rearLoose` share 0,
  `counterLock: [0, 1]`, `spinLat: 0`, `spinDrive: 0`, `yawCap` gain 0, `counterSteer` gain 0, `autoCounter: 0`,
  `steerComply: 0`, `rotInertia: [0, 0]`, `autoUndersteer: 0`, optional `pacFront` and `brush`), so F1 handling stays
  identical. `forceHeight` (0.12 on the F1 and drift car) is how far above the road the tyres' grip acts on the body:
  it cuts their load transfer to that of a lower centre of mass.
- **GT3**: LibreCorsa's Mercedes-AMG GT3 (`src/lib/sim/gt3/AmgGt3Config.ts` in github.com/KhazP/librecorsa, MIT).
  Its data goes straight into the spec; what this physics lacked to reproduce that car was added as opt-in fields:
  `brush` (Fiala brush tyre curve per axle, with power-law load sensitivity, instead of `pac`), `steerComply`
  (steering flex, most of its understeer gradient; filtered over `COMPLY_T` because at 120 Hz the flex and the
  cornering force would otherwise chase each other), `rotInertia` (engine and wheel inertia, taken off the drive
  force at the car's own acceleration) and `forceHeight: 0` (full load transfer; with their tyre grip unscaled this
  is what put the cornering g on their numbers). Four values are fitted rather than copied: `GT3_CAMBER` (their
  tyres gain about 3% cornering grip from camber, which is not modelled), `brakeGrip` (0.825: their car brakes at a
  lower share of its cornering grip than the tyre data alone says), `brakeMax` (94% of their brake torque, which is
  what their car uses at speed) and `steerComply` (theirs is 0.28 deg/kN; 0.34 here also stands in for their bump
  steer). Not modelled: tyre heat/pressure/wear, suspension geometry, the
  differential, ride-height aero. There is no wheelspin model either, so the GT3 cannot be spun on the power even
  with TC off (theirs can; `lcgt3` is that car on their own engine). The autopilot adds lock for the understeer (`autoUndersteer`), or it runs wide at speed.
- **Two engines**: every car spec is a `CarInfo` (what the game outside the physics reads: menu, body geometry,
  HUD/sound engine numbers, cameras, the autopilot's plan inputs) with a `physics` discriminant. `CarSpec` (`'rapier'`)
  adds our physics numbers; `LcSpec` (`'lc'`) adds a LibreCorsa car config and driver. `createVehicle` in `sim.ts`
  builds the right class; `stepPhysics` calls `car.step`, steps the Rapier world only for Rapier cars, then
  `car.readState`. Code outside `car.ts` must use `Vehicle` / `CarInfo`, never `Car` / `CarSpec`.
- **LibreCorsa engine (`src/lc/`)**: the `lcgt3` and `lcf1` cars (menu names "GT3 (LC)", "F1 2026 (LC)").
  - `lc/vendor/`: LibreCorsa's car physics (`VehiclePhysics`, github.com/KhazP/librecorsa, MIT) and the two cars'
    data, copied nearly verbatim. Do not edit it except to re-vendor: its README lists the upstream commit, the
    files and the four edits (one removes third-party CC BY-NC-SA rain-tyre data; keep it out). The engine runs
    fixed 2 ms steps, has its own rigid body and wall response, and has no ABS, TC or input shaping.
  - `lc/lcCar.ts`: `LcCar implements Vehicle`. Each 120 Hz tick runs 4 or 5 engine steps (25 per 6 ticks, counted in
    integers so it never drifts), with the driver around each. It owns our gearbox conventions (reverse on the
    brake at a standstill, one manual shift per tick, `shiftDenied`), the F1's flaps (open by themselves in
    `straightWindows`: straights of 250 m+) and lap energy (`locateProgress`), and maps engine state to ours.
    `placeAt` on the first-placement spot (the start spot, which is the only place the session puts it) builds a
    fresh engine instance (full battery, fuel, tyres in blankets; cheap because the engine memoises that settle),
    rolling at the given speed through the engine's own rolling start; anywhere else (tests) it is a teleport that
    keeps battery and lap energy (20–40 ms: the engine settles the car by simulating).
  - `lc/ground.ts`: the engine's ground (our surfaces mapped to its road/kerb/grass/gravel table, kerb height on
    top of flat ground) and walls (the road-facing face of each barrier cuboid) from a `Track`. Lookups use a
    per-track grid and no search hint, so they are stateless, which the engine's settle memo requires.
  - `lc/engineDriver.ts` (the contract), `lc/driver.ts`, `lc/aids.ts`, `lc/steering.ts`: our port of what
    LibreCorsa's game adapter does around the engine, run every 2 ms step because the aid filters are tuned for
    500 Hz. Keys: pedal ramps and LibreCorsa's keyboard steering assist. Analog (mouse, stick): the input is the
    rack position, rate-limited and not scaled by speed, as LibreCorsa's (the owner asked for the speed-sensitive
    lock these cars first had to be removed; the tyres' peak is at 0.2-0.5 of the travel, see `driver.ts`).
    Autopilot `steerAngle`: straight to the road wheels. ABS is always on; the TC setting switches TC between the
    car's "semi_pro" dial and off. Per-car numbers are `GT3_DRIVER` / `F1_DRIVER`.
  - The engine's axes are ours (x left, y up, z forward) but its steering input is + = right, and its reverse gear
    is -1 (ours 0).
- **Car physics (`Car.step`)**: Rapier rigid body at a fixed 120 Hz (`DT`), with custom physics on top:
  - raycast suspension with anti-roll bars
  - Pacejka lateral curve with load sensitivity (or a brush tyre: `spec.brush`)
  - friction circle with ABS-style brake priority, stretched along the wheel by `brakeGrip` / `driveGrip`
  - optional countersteer assist for the player's steering (`counterSteer`, enabled by `car.assist` from the
    Countersteer assist setting, off by default); the autopilot's `steerAngle` bypasses it, so assist tuning does
    not move the pinned lap times
  - traction control (`tcSlack`)
  - per-surface grip blending and grass/gravel ploughing
  - downforce and drag

  Rendering interpolates between physics states (`prevPos` / `prevQuat`).
  Drift-car stability lesson: the rear must out-grip the front at speed (`gripRear > gripFront` by ~10%+), or the car
  yaws itself round under braking at 200 km/h; looseness is added only at low speed (`rearLoose`) or while
  braking + steering (`brakeKick`).
  Drift-car lessons (the owner drives it with the mouse: check changes with an analog driver, as the `mouse()`
  helper in `test/handling.test.ts` does, not only with full-lock keys):
  - Slides come from the throttle. The rear is loose under power and, by `rearLoose`'s steerIn share, when steering
    into the turn; coasting leaves the offThrottle share, so lifting recovers. The looseness is sideways only (it
    does not cost traction) and eases in and out over `rearLoose`'s ease time: stepping it made the car snappy.
  - Past `rearCatch`'s first angle the looseness fades and the rear gains a little grip, so a slide settles (about
    30 deg) and holds for as long as the throttle is down. Without it, more looseness meant spins; with the dig-in
    starting too late, moderate steering off the throttle already gave a 40 deg slide.
  - A spinning rear tyre keeps most of its cornering force (`spinLat`) and still drives the car (`spinDrive`).
    Without the drive share a held slide bogged down from 90 to 30 km/h ("heavy"); with a low `spinLat` instead,
    the car spun under power.
  - `yawCap` limits how much faster than its cornering rate the car can rotate. Direction changes otherwise whip
    the tail to 70-80 deg and spin it: that is yaw momentum, which grip, yaw inertia and `angDamp` do not fix.
  - The rear tyre curve barely falls off past its peak (`pac.C` 1.35; at 1.6 big slides were spins).
  - `counterLock` (keys only) makes opposite lock follow the slide angle, because a key cannot choose an angle.
    Analog steering is left alone: scaling a mouse user's own countersteer felt wrong.
- **Switching cars**: `applySetting.car` in `main()` calls `Session.setCar`, which destroys the old `Car` (body +
  mesh), builds a new one, swaps the timing store and restarts at the start spot; then it re-applies the gearbox/TC settings.
  `session.car` is replaced, so closures must read it at call time, never keep it.
- **Settings and menu**: `settings.ts` has the `Settings` type, `SETTING_DEFS` (menu rows and their order) and
  `DEFAULT_SETTINGS`; `main()` has the `applySetting` table (what each setting does). `setSetting` saves to
  `localStorage` `fastroads.settings` and calls `applySetting`; in-game hotkeys go through `cycleSetting` so the menu
  stays in sync. Adding a setting means adding it to all four; the compiler flags any you miss.
- **Timing**: start/finish and two sector lines as segments, with crossings interpolated within a tick; track-limit
  invalidation; best lap/sectors/trace stored per circuit and car under `TrackDef.storeKey + spec.storeKey`
  (`useStore` switches).
- **Input**: keyboard, gamepad and visible-cursor mouse steering (cursor x relative to screen centre, with
  sensitivity/deadzone settings) merge in `Input.poll` into one input object. `input.mouse.active` is set each frame
  by the game loop (driving, not paused or in the menu).
- **Autopilot**: pure pursuit on the centreline plus a speed profile from `buildSpeedProfile(track, spec)`, cached
  per car on `track.speedProfiles`. Brake-marker boards are scenery and are always placed from the F1 profile.
