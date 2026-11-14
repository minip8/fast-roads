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
    npm test            # Vitest, headless physics (~30 s)
    npx vitest run test/handling.test.ts -t 'F1'   # one file / one test by name
    npm run build       # typecheck + static build in dist/ (base './'); npm run preview serves it

Run `npm run typecheck` and `npm test` before committing.

## Testing

- Tests run the real simulation in Node: `test/harness.ts` `session(carId, { tc })` builds the track, Rapier world,
  car and timing with no rendering. `drive(seconds, driver?)` steps physics with the autopilot or a
  `(car, simTime) => DriveInput` function. Each tick goes through `stepPhysics` in `src/sim.ts`, the same function
  the game loop uses.
- The simulation is deterministic, and Node and the browser agree to the millisecond. `test/laps.test.ts` pins
  autopilot lap times (F1 1:59.659, drift car 182.572 s with TC on, 187.424 s off), so any physics or tuning change
  shows up there. When a change is intended, check the handling still makes sense, then update the expected times.
- `test/handling.test.ts` holds loose-bound checks of tuning intent: the drift car's brake-and-turn kick, a stable
  F1. `car.forceSurface = S_ASPHALT` keeps manoeuvres off grass. Keep them short (about 1–2 s after the manoeuvre):
  the start straight is walled.
- In the browser, `window.__game` exposes `simulate(seconds, driver, probeSecs)`, `car` (a getter: the car object is
  replaced when you switch cars), `timing`, `track`, `setSetting(key, value)` and `setAutopilot`. Use it for
  checks that need the page (menu, HUD, settings), e.g. from headless Chromium.

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
- `sim.ts`: one physics tick
- `carMeshes.ts`: car bodies
- `track.ts`: track geometry and colliders (`Track`)
- `trackMeshes.ts`, `textures.ts`, `scenery.ts`, `brakeMarkers.ts`: visuals
- `timing.ts`, `input.ts`, `audio.ts`, `dust.ts`, `autopilot.ts`
- `stage.ts`: renderer, scene, lights, static track visuals (`buildStage`)
- `camera.ts`: `CameraRig` (camera modes)
- `settings.ts`: setting types, menu rows, defaults, load/save
- `menu.ts`: `Menu`, which talks to `main.ts` only through the `MenuHost` callbacks
- `hud.ts`, `minimap.ts`: in-game HUD; `dom.ts`: `$` element lookup
- `main.ts`: wires it together and owns game state (`car`, `started`/`paused`, `simTime`, the `applySetting`
  table, hotkeys, the frame loop)

- **Track data**: `tracks/melbourne.csv` (TUM racetrack-database centreline + widths), imported into `main.ts` with
  Vite's `?raw` suffix; `parseCSV` skips `#` comment lines.
  `buildTrack` turns it into a closed spline sampled every ~2 m (arrays `X, Z, TX, TZ, NX, NZ, K, S, WL, WR`, kerb/
  gravel/barrier offsets). Almost everything works in track coordinates `(s, lat)` via `projectOnTrack` / `pointAt`.
- **Car specs (`CARS`)**: every physics, engine, gearbox, steering, collider, camera and autopilot number for each car
  (`f1`, `drift`), plus its mesh builder and its lap-time `storeKey`. The `Car` class reads only `this.spec`, so a
  new car is a new spec entry. Behaviour toggled per car uses neutral defaults on the F1 (e.g. `brakeKick: 0`,
  `rearLoose: [0, 1]`, `autoCounter: 0`, optional `pacFront`), so F1 handling stays identical.
- **Car physics (`Car.step`)**: Rapier rigid body at a fixed 120 Hz (`DT`), with custom physics on top:
  - raycast suspension with anti-roll bars
  - Pacejka lateral curve with load sensitivity
  - friction circle with ABS-style brake priority
  - traction control (`tcSlack`)
  - per-surface grip blending and grass/gravel ploughing
  - downforce and drag

  Rendering interpolates between physics states (`prevPos` / `prevQuat`).
  Drift-car stability lesson: the rear must out-grip the front at speed (`gripRear > gripFront` by ~10%+), or the car
  yaws itself round under braking at 200 km/h; looseness is added only at low speed (`rearLoose`) or while
  braking + steering (`brakeKick`).
- **Switching cars**: `applySetting.car` in `main()` destroys the old `Car` (body + mesh), builds a new one,
  re-applies gearbox/TC settings, swaps the timing store and resets to the grid. `car` in `main()` is a `let`;
  closures must read it at call time, never cache it.
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
