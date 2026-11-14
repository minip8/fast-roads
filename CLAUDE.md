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
    npm test            # Vitest, headless physics (~20 s: the test files run in parallel)
    npx vitest run test/handling.test.ts -t 'F1'   # one file / one test by name
    npm run build       # typecheck + static build in dist/ (base './'); npm run preview serves it

Run `npm run typecheck` and `npm test` before committing.

## Testing

- Tests run the real simulation in Node: `test/harness.ts` `session(carId, { tc, walls })` builds the track and the game's
  own `Session` (`src/sim.ts`: Rapier world, walls, car on the grid, timing) with no rendering. `drive(seconds,
  driver?, until?)` calls `Session.tick` with the autopilot or a `(car, simTime) => DriveInput` function, exactly as
  the game loop does, including the automatic resets; `until` stops early once the test has what it measures.
- The simulation is deterministic, and Node and the browser agree to the millisecond. `test/laps.ts` pins
  autopilot lap times (F1 1:59.659, drift car 172.145 s with TC on, 172.217 s off), so any physics or tuning change
  shows up there. When a change is intended, check the handling still makes sense, then update the expected times.
  Each lap is run by its own `laps-*.test.ts` file so the three (about 12–18 s each) run in parallel.
- `test/handling.test.ts` holds loose-bound checks of tuning intent: the drift car's brake-and-turn kick, a stable
  F1. `car.forceSurface = S_ASPHALT` keeps manoeuvres off grass. Keep them short (about 1–2 s after the manoeuvre):
  the start straight is walled (`walls: false` removes the barriers for manoeuvres that need the room).
- In the browser, `window.__game` exposes `simulate(seconds, driver, probeSecs)`, `car` (a getter: the car object is
  replaced when you switch cars), `simTime`, `session`, `timing`, `track`, `input`, `setSetting(key, value)` and
  `setAutopilot` (the `GameHook` type in `main.ts`). Use it for checks that need the page (menu, HUD, settings), e.g.
  from headless Chromium.

## Architecture (`src/`)

`index.html` is just the page markup (HUD, menu); styles are in `src/style.css`. Modules:
- `boot.ts`: the entry point; checks for WebAssembly/WebGL 2, then `import('./main')` and calls `main()`. Startup
  failures (missing feature, failed chunk or wasm download, other errors) go to `startup.ts`, which shows a message
  with a retry button in `#loadState`. The build preloads the dynamically imported chunks from `index.html`.
- `sw.js`: service worker template (plain JS). The build writes `dist/sw.js` with the list of every output file to
  precache; `boot.ts` registers it in production only. `index.html` is network-first, everything else cache-first.
  `public/` holds the icon and web app manifest.
- `config.ts`: constants, surfaces, collision groups
- `util.ts`: math and formatting helpers
- `cars.ts`: car specs (`CarSpec`)
- `car.ts`: car physics (`Car`, `DriveInput`)
- `sim.ts`: `stepPhysics` (one physics tick; replaces non-finite input, which would abort Rapier) and `Session`
  (world, walls, car on the grid, timing; `tick`, `resetToTrack`, `restart`, `setCar`), shared by the game and tests
- `carMeshes.ts`: car bodies, static parts merged per material. Paint and metal reflect the environment map that
  `stage.ts` hands over with `setCarEnvironment` before any car is built.
- `track.ts`: track geometry and colliders (`Track`)
- `trackMeshes.ts`, `textures.ts`, `scenery.ts`, `brakeMarkers.ts`: visuals; `batch.ts`: `Batch`, which merges many
  static parts into one mesh per material (grandstands, pit, gantry, brake boards, car bodies)
- `audio.ts`: `EngineAudio`, the AudioContext's lifecycle (created on the first gesture, suspended while muted or
  hidden); `audioGraph.ts`: `SoundGraph`, every sound node, built once, with `update()` moving only parameters.
  It reads the car through the `AudioCar` interface and each car's `spec.sound` (`EngineVoice`).
- `timing.ts`, `input.ts`, `dust.ts`, `autopilot.ts`
- `stage.ts`: renderer, scene, lights, sky, shadow-following sun, static track visuals (`buildStage`)
- `camera.ts`: `CameraRig` (camera modes)
- `settings.ts`: setting types, menu rows, defaults, load/save
- `menu.ts`: `Menu`, which talks to `main.ts` only through the `MenuHost` callbacks
- `hud.ts`, `minimap.ts`: in-game HUD (`Hud.update` runs every frame but writes only text/classes/styles that
  changed); `dom.ts`: `$` element lookup
- `main.ts`: wires it together and owns game state (the `Session`, `started`/`paused`/autopilot, the
  `applySetting` table, hotkeys, the `window.__game` hook (typed `GameHook`), the frame loop)

- **Track data**: `tracks/melbourne.csv` (TUM racetrack-database centreline + widths), imported into `main.ts` with
  Vite's `?raw` suffix; `parseCSV` skips `#` comment lines.
  `buildTrack` turns it into a closed spline sampled every ~2 m (arrays `X, Z, TX, TZ, NX, NZ, K, S, WL, WR`, kerb/
  gravel/barrier offsets). Almost everything works in track coordinates `(s, lat)` via `projectOnTrack` / `pointAt`.
- **Car specs (`CARS`)**: every physics, engine, gearbox, steering, collider, camera, sound and autopilot number for
  each car (`f1`, `drift`), plus its mesh builder, its engine voice (`sound`, an `EngineVoice` from `audioGraph.ts`)
  and its lap-time `storeKey`. The `Car` class reads only `this.spec`, so a new car is a new spec entry
  (`test/cars.test.ts` checks each spec fits the menu, gearbox, mesh and autopilot). Behaviour toggled per car uses
  neutral defaults on the F1 (e.g. `brakeKick: 0`, `brakeGrip: 1`, `driveGrip: 1`, `rearLoose: [0, 1, 1]`, `spinLat: 0`,
  `counterSteer` gain 0, `autoCounter: 0`, optional `pacFront`), so F1 handling stays identical.
- **Car physics (`Car.step`)**: Rapier rigid body at a fixed 120 Hz (`DT`), with custom physics on top:
  - raycast suspension with anti-roll bars
  - Pacejka lateral curve with load sensitivity
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
  Drift-car catchability lesson: slides must be recoverable without an assist. That needs the rear to get its grip
  back when the driver lifts (`rearLoose` off-throttle share), a rear tyre curve that barely falls off past its peak
  (`pac.C` 1.35; at 1.6 any slide beyond the keyboard's steering lock was a spin), and wheelspin that leaves the
  rear some cornering force (`spinLat`). `test/handling.test.ts` checks each with keyboard-style drivers.
- **Switching cars**: `applySetting.car` in `main()` calls `Session.setCar`, which destroys the old `Car` (body +
  mesh), builds a new one, swaps the timing store and resets to the grid; then it re-applies the gearbox/TC settings.
  `session.car` is replaced, so closures must read it at call time, never keep it.
- **Settings and menu**: `settings.ts` has the `Settings` type, `SETTING_DEFS` (menu rows and their order) and
  `DEFAULT_SETTINGS`; `main()` has the `applySetting` table (what each setting does). `setSetting` saves to
  `localStorage` `fastroads.settings` and calls `applySetting`; in-game hotkeys go through `cycleSetting` so the menu
  stays in sync. Adding a setting means adding it to all four; the compiler flags any you miss.
- **Timing**: start/finish and two sector lines as segments, with crossings interpolated within a tick; track-limit
  invalidation; best lap/sectors/trace stored per car under `spec.storeKey` (`useStore` switches).
- **Input**: keyboard, gamepad and visible-cursor mouse steering (cursor x relative to screen centre, with
  sensitivity/deadzone settings) merge in `Input.poll` into one input object. `input.mouse.active` is set each frame
  by the game loop (driving, not paused or in the menu).
- **Autopilot**: pure pursuit on the centreline plus a speed profile from `buildSpeedProfile(track, spec)`, cached
  per car on `track.speedProfiles`. Brake-marker boards are scenery and are always placed from the F1 profile.
