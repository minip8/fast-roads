# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow

- Commit after each change. Use a short imperative subject line and a brief body explaining what changed and why,
  matching the existing history.
- Keep `README.md` in sync when controls, settings, cars or physics behaviour change (it documents all of them).

## Running

No build, package manager, linter or test suite. The whole game is `index.html`; three.js and Rapier load from the
jsDelivr CDN through an import map, so it needs a network connection.

    python3 -m http.server 8000   # then open http://localhost:8000
    # ?autopilot in the URL skips the menu and lets the built-in driver lap

Quick syntax check of the game module (the import-map and CSV `<script>` blocks aren't JS, so check only the module):

    L=$(grep -n '<script type="module">' index.html | cut -d: -f1)
    awk -v L=$L 'NR>L && /<\/script>/{exit} NR>L' index.html > /tmp/game.mjs && node --check /tmp/game.mjs

## Testing

Use the test hook `window.__game`, from the browser console or headless Chromium (e.g. Playwright):
- `simulate(seconds, auto, probeSecs)` runs physics without rendering. `auto` is `true` (autopilot), `false`
  (live input), or a function `(car, simTime) => inputs` returning `{ throttle, brake, steer, analog, steerAngle?, autoGears? }`.
  With `probeSecs` it returns a log of position/speed/gear samples.
- `car` (a getter: the car object is replaced when you switch cars), `timing` (`timing.laps`), `track`, `autopilot`,
  `setSetting(key, value)`, `setAutopilot`.
- Simulation is deterministic: the same build gives the same autopilot lap time to the millisecond, so comparing an
  autopilot lap against `git show HEAD:index.html` served on another port is a reliable regression check
  (F1: 1:59.659).
- `car.forceSurface = 0` forces asphalt under every wheel for synthetic handling tests. Keep such tests short
  (about 1–2 s after the manoeuvre): the start straight is walled, and longer runs hit the walls.

## Architecture (all in `index.html`)

The file is split into `// ====` banner sections, in this order: config, car specs, helpers, track, meshes,
colliders, scenery, brake markers, Car, car meshes, dust, timing, input, audio, autopilot, `main()`.

- **Track data**: `tracks/melbourne.csv` (TUM racetrack-database centreline + widths) is the source; a copy without
  its two `#` header lines is embedded in the `<script id="track-csv">` block. Edit both together.
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
- **Switching cars**: `setSetting('car', id)` in `main()` destroys the old `Car` (body + mesh), builds a new one,
  re-applies gearbox/TC settings, swaps the timing store and resets to the grid. `car` in `main()` is a `let`;
  closures must read it at call time, never cache it.
- **Settings and menu**: `SETTING_DEFS` drives both the menu rows and persistence (`localStorage`
  `fastroads.settings`); `setSetting` is the single place side effects happen, and in-game hotkeys go through
  `cycleSetting` so the menu stays in sync. Adding a setting = a `SETTING_DEFS` entry, a default in `settings`, and a
  branch in `setSetting`.
- **Timing**: start/finish and two sector lines as segments, with crossings interpolated within a tick; track-limit
  invalidation; best lap/sectors/trace stored per car under `spec.storeKey` (`useStore` switches).
- **Input**: keyboard, gamepad and visible-cursor mouse steering (cursor x relative to screen centre, with
  sensitivity/deadzone settings) merge in `Input.poll` into one input object. `input.mouse.active` is set each frame
  by the game loop (driving, not paused or in the menu).
- **Autopilot**: pure pursuit on the centreline plus a speed profile from `buildSpeedProfile(track, spec)`, cached
  per car on `track.speedProfiles`. Brake-marker boards are scenery and are always placed from the F1 profile.
