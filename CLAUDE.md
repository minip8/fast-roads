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
    npm run typecheck   # tsc for src/, then test/ and ai/ (only those get Node types)
    npm test            # Vitest project `unit`: headless physics (~35 s: the test files run in parallel)
    npm run test:laps   # Vitest project `laps`: the pinned laps at the 22 other circuits (2-4 min)
    npx vitest run test/handling.test.ts -t 'reverse'   # one file / one test by name
    npm run build       # typecheck + static build in dist/ (base './'); npm run preview serves it
    npm run build:env   # RL environment worker -> build/env/worker.mjs (git-ignored); node ai/client.mjs drives it
    npm run server      # multiplayer relay -> build/server/server.mjs, listening on ws://*:8787 (PORT, HOST, MAX_PLAYERS, BATCH_MS)
    node scripts/cars/convert.mjs lcgt3 <source.glb>   # remake a car model (sources: see its header)
    node scripts/tracks/convert.mjs <racetrack-database> <f1-circuits> [id ...]   # remake circuit CSVs (see its header)

Run `npm run typecheck` and `npm test` before committing, and `npm run test:laps` too after a change to physics,
tuning, the autopilot or track building (`src/track.ts`, `tracks/`).

## Testing

- Tests run the real simulation in Node: `test/harness.ts` `session(carId, { tc, walls })` builds the track and the game's
  own `Session` (`src/sim.ts`: Rapier world, walls, car at the start spot, timing) with no rendering. The car starts
  at rest on the start straight (`REST_BACK` m before the line: Melbourne and Silverstone, the circuits tests start
  at rest on); `session(carId, { flying: true })` starts it as the game does, at the circuit's start spot before
  the last corners, at flying-lap speed. `drive(seconds,
  driver?, until?)` calls `Session.tick` with the autopilot or a `(car, simTime) => DriveInput` function, exactly as
  the game loop does, including the automatic resets; `until` stops early once the test has what it measures.
- The simulation is deterministic, and Node and the browser agree to the millisecond. `test/laps.ts` pins
  autopilot lap times from the game's flying start at every circuit, so any physics or tuning change shows up
  there. Melbourne and Silverstone run in `npm test`: Melbourne `lcf1` 116.548 s, `lcgt3` 133.860 s, drift car 157.515 s with TC on and 157.492 s off;
  Silverstone `lcf1` 123.931 s, `lcgt3` 144.184 s, drift car 169.789 s. When a change is intended, check the
  handling still makes sense, then update the expected times. Each lap test also checks that the car passes the start
  spot at the end of the lap within 2 km/h of its `TrackDef.flying` speed; `test/start.test.ts` checks the flying
  start (the run-up through Albert Park's last corners), the restart, and track limits in the run-up. Each lap is run by its own `laps-*.test.ts` file so the seven (about
  10–20 s each) run in parallel. The other 22 circuits' laps (TC on, all three cars: `CALENDAR` in `test/laps.ts`)
  are 66 more, too many for every commit: they are the Vitest project `laps` (`test/calendar/<circuit>.test.ts`,
  three laps a file; `npm run test:laps`, 2-4 minutes on 12 cores), and `npm test` is the project `unit`
  (`test/*.test.ts`), set up in `vite.config.ts`. Every lap test also checks there were no resets and that the car's
  centre never came within 2 m of a wall, except the one lap pinned as not clean (`NOT_CLEAN`: the drift car slides
  wide at Spa's Blanchimont and Bus Stop and has its lap deleted). `session(carId, { track })` picks the circuit (Melbourne by default);
  `trackFor(id)` builds a circuit once per test file.
- `test/tracks.test.ts` checks every circuit's data cheaply (in `npm test`): lap length within 1.5% of the official
  `lengthKm`, a unique best-times key, the start spot (a corner of radius 250 m or less between it and the line, at
  most 1200 m back, on a straight or nearly: radius 250 m+ for 5 m either side, on asphalt between walls), a
  flying speed for every car, walls all round
  except where another part of the lap passes (Suzuka's crossover, inside tight hairpins), the pit building and
  grandstands placed without reaching another part of the circuit, and the calendar order.
- `test/flying.test.ts` is a tool, skipped unless `FLYING` is set: `FLYING=monza npm run tracks:flying` (circuits
  separated by spaces or commas, or `all`; three autopilot laps a circuit, about 40 s, one circuit after another, so
  run several shells for many) prints each circuit's `startBack` and `flying` line for `src/tracks.ts`, the run-up
  time per car and the lap times from the current start. The start spot rule (`ruleStart`): walking back from the
  line past the last corner of radius 150 m or less to the first straight (radius 300 m+) at least 40 m long, 1 s
  of the GT3's travel before it brakes there, at least 15 m inside the straight. `TrackDef.startManual` (with a
  comment on what the rule picked) marks the four set by hand (Miami, Monaco, Mexico City, Baku: the rule's spot was
  a 21–28 s run-up). The speeds are measured from laps started at the current spot, so after moving a start run the
  lap tests, which check the speed there within 2 km/h.
- `test/rearview.test.ts` checks the look-behind camera in every mode and the mirror's camera and flip (geometry
  only; the mirror pass itself needs a browser: `__game.mirror.stats` has its draw calls and triangles).
- `test/handling.test.ts` holds loose-bound checks of tuning intent: the drift car's brake-and-turn kick, slides,
  stopping distance, gearbox and reverse. `car.forceSurface = S_ASPHALT` keeps manoeuvres off grass. Keep them short (about 1–2 s after the manoeuvre):
  the start straight is walled (`walls: false` removes the barriers for manoeuvres that need the room).
- `test/ghost.test.ts`: ghost laps. The timing rules (which lap becomes the ghost, packing round trip, storage,
  corrupt data, quota) run with a scripted car fed straight to `Timing.tick` (no physics, so quick); playback
  accuracy with an autopilot lap of the drift car (on LibreCorsa's engine a tick is 4 or 5 engine steps, so per-tick
  positions are themselves uneven and make a poor reference).
- LibreCorsa-engine cars (`src/lc/`) have three layers of tests: `test/lc-engine.test.ts` (the vendored engine alone
  on flat ground; `test/lc-gt3-reference.ts` ports LibreCorsa's own GT3 measurement and must match upstream's
  numbers to four decimals, so any accidental change to `src/lc/vendor/` shows up), `test/lc-driver.ts` (ABS, TC,
  keyboard and analog steering through `src/lc/driver.ts`, one file per car) and `test/lc-car.ts` (the cars in the
  game's `Session`: start spot, walls, surfaces, placement and restarts, shifts and reverse, rendering, the F1's flaps and lap energy, tyre telemetry over a lap).
  Tests that reach into our own physics use `ourCar(car)` / `ourSpec(spec)` from the harness, which fail for a car
  on another engine.
- `test/ai-env.test.ts` checks the RL environment (`src/ai/`): the observation against its spec, bit-identical
  determinism, the autopilot's pinned lcf1 Melbourne lap through evaluation mode (so a physics change that moves the
  pinned laps moves it too: update both), random starts, every episode end, automatic resets.
  `test/ai-worker.test.ts` builds the worker into a temporary folder and drives it over the protocol with
  `ai/client.mjs`, comparing every reply bit for bit with the same environments run in-process.
- Multiplayer: `test/net-*.test.ts` cover `src/net/` and the relay on their own (docs/net.md, **Tests**);
  `test/multiplayer.test.ts` joins game Sessions (harness `session()`) through an in-process `Relay` over
  `LoopbackNet` (40 ms + jitter, loss) with `Multiplayer`, ticked in lockstep: proxy error against the other
  client's real car, a rear-end hit seen by both simulations (no event applied) and by one (`localCollisions =
  false` on the other: every event applied once), momentum equal and opposite within 35%, restarting onto an
  occupied spot, pausing, joins, car changes, leaving, a lap (driven by placing the car before each timing line) on
  the board. About 5 s. `NET_REPORT=1` prints the measurements quoted in docs/net.md.
- In the browser, `window.__game` exposes `simulate(seconds, driver, probeSecs)`, `car` (a getter: the car object is
  replaced when you switch cars), `simTime`, `session`, `timing`, `track`, `input`, `setSetting(key, value)` and
  `setAutopilot`, `stage` (renderer, scene, camera; the `GameHook` type in `main.ts`) and `multiplayer` (the
  room's `Multiplayer`, or null). Use it for checks that need the page (menu, HUD, settings), e.g.
  from headless Chromium; `input.bindings` holds the current keys. Judge menu and HUD changes by screenshots, at a
  desktop and a phone width.
- `test/storage.test.ts` covers loading settings and key bindings (corrupt, old or invalid data loads as defaults)
  and `nextOption`; `test/tracks.test.ts` checks each circuit's menu card (length, outline).

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
  `TrackDef.startBack` metres before the line (on the straight before the last corner or corners, so a restart
  costs the run-up, 8–20 s), rolling at its `TrackDef.flying` speed (`Vehicle.placeAt(s, lat,
  speed, heading)`; heading, an angle off the racing direction, is for the RL environment's random starts), and the
  lap under way is dropped. Extra cars (`addCar` / `removeCar`, `others`: each with its own driver, the autopilot by
  default; no timing; put back at their own start on a restart or when stuck) and `proxies` (`ContactBody`s simulated
  elsewhere, e.g. another player's car: the session's cars are pushed off them, they are never moved) switch `tick`
  to `stepAll`: every car steps, the world steps once, `resolveContacts` runs (all pairs, then each car against each
  proxy) and `contacts` lists the tick's hits. With neither, `tick` is `stepPhysics` alone, so the single-car path
  (and the pinned laps) are untouched. `resets` counts placements at the start spot (multiplayer watches it). `?opponents=N` or `?opponents=lcgt3,drift` adds autopilot cars in the game
- `collide.ts`: car-to-car contact on an engine-neutral `ContactBody` (centre of mass, heading, velocity, yaw rate,
  `ContactShape`: nose and tail distances, half width, mass, yaw inertia; `contactBody(vehicle)` reads a car).
  `collide(a, b)` wraps the vendored `resolveCarToCarObbCollision` (handed the box centre and its velocity, the yaw
  changes worked out again about each centre of mass; overlap push capped at `MAX_PUSH`) and returns both sides'
  `ContactDelta`; `Vehicle.applyContact(d)` applies one to either engine's body (`Vehicle.shape` is its footprint).
  Yaw rate is `angv.y` (+ turns the nose left, towards +x). Tests: `test/collide.test.ts`.
- `carMeshes.ts`: car bodies, static parts merged per material, each with a seated driver and steering wheel
  (`Cockpit`: the Driver camera's eye, the helmet it hides, and `poseCockpit`, which both cars' `render` call to turn
  the wheel and arms, and `screen`, the live instruments). Paint and metal reflect the environment map that
  `stage.ts` hands over with `setCarEnvironment` before any car is built. `CarMesh.dispose()` frees a body on car
  switch. The GT3 (`LC_GT3_MODEL`) is a 3D model (`public/cars/<id>/model.glb` + `LICENSE.md`,
  CC BY-NC-SA: credits in README): the procedural body is built first (and is all the tests get), and when
  `carModels.ts` (GLTFLoader + meshopt, browser only, installed by `stage.ts`) has loaded the file, the body,
  wheels (`spinner` moves to the model's wheel centre), calipers, steering wheel and brake light are swapped in
  place, so `mesh.cockpit` / `mesh.brakeLight` change: read them at use. A loaded model is cached and shared by
  every car built from it (`userData.shared`: never disposed). `scripts/cars/convert.mjs` makes the files from the
  Sketchfab downloads (part names and `extras.frame` documented there); `test/carModels.test.ts` checks them
  against the specs' axles. The vite config finds every `public/cars/<id>/model.glb` by itself (`__CAR_MODELS__`).
- `cockpitDisplay.ts`: the live instruments in the Driver camera (`Cockpit.screen`): one unlit mesh per car (the
  screen plus its shift-light strip, `buildScreen`, built with the body, Node too) textured by a canvas made in the
  browser on first use (`userData.owned`: disposed with the car). `CockpitDisplay.update` (from `main.ts`'s frame
  loop) redraws it only in the Driver camera, when a value of `dashValues` changes, at most 30 Hz; its `unit` is the
  speed unit. A model's own screen is hidden in the car's copy and the live one placed over it (`CarModelDef.screen`).
  Extra readouts come from `Vehicle` (`tcActive`, `absActive`, optional `battery`, `flapsOpen`). Tests:
  `test/cockpitDisplay.test.ts` (values, meshes, disposal; no drawing in Node).
- `tracks.ts`: the circuits (`TRACKS`, `TrackDef`, in calendar order): names, display data for the circuit picker
  (`country`, official `lengthKm`, 2026 `round`, none for the cancelled Bahrain and Jeddah), best-times key, start
  spot and each car's flying-lap speed there, scenery placement; `loadTrackCsv(id)` fetches one circuit's CSV
  (`import.meta.glob` makes each CSV its own chunk, so the game downloads only the circuit being driven)
- `track.ts`: track geometry and colliders (`Track`)
- `trackMeshes.ts`, `textures.ts`, `scenery.ts`, `brakeMarkers.ts`: visuals (`standBays` / `pitBuilding` in
  `scenery.ts` place the buildings, leaving out or shortening any that would stand inside another stretch's walls); `batch.ts`: `Batch`, which merges many
  static parts into one mesh per material (grandstands, pit, gantry, brake boards, car bodies)
- `audio.ts`: `EngineAudio`, the AudioContext's lifecycle (created on the first gesture, suspended while muted or
  hidden); `audioGraph.ts`: `SoundGraph`, every sound node, built once, with `update()` moving only parameters.
  It reads the car through the `AudioCar` interface and each car's `spec.sound` (`EngineVoice`). A voice with
  `loops` (only the GT3's) plays synthesised loop buffers instead of the oscillators: `engineLoops.ts` makes them
  in plain JS (exhaust pulses per cylinder in the firing order, a waveguide pipe per bank, saturation; whole engine
  cycles, so they loop seamlessly), one per `update()` the first time the voice is used (the oscillators play
  meanwhile), and `LoopPlayer` crossfades them by rpm and throttle and adds overrun pops and gear whine.
  `test/engineLoops.test.ts` checks the loops (seams, level, cross-plane spectrum, weight under the firing note and
  little buzz, brighter on load); `test/engineVoice.test.ts` checks the oscillator voices the same way, computing
  their spectrum from the wave (`cycleHarmonics`: one engine cycle, so `orders` can add crank orders under the
  firing note) and the graph's biquads. Tyre noise is `tyreNoise` (squeal from `SQUEAL_SLIP`, faint scrub below)
  on `VehicleWheel.slip`, which both engines report as 1 at the tyre's grip peak whichever way it slips (`peakSlip`
  in `lcCar.ts` rescales the engine's lateral-peak combinedSlip; `car.ts` divides by `pacejkaPeak`);
  `test/tyreNoise.test.ts` holds when it plays. Measure a sound change rather than guessing: render it offline
  (an `OfflineAudioContext` in headless Chromium plays the real graph) and compare spectra and levels.
- `timing.ts`, `input.ts`, `dust.ts`, `autopilot.ts`
- `ghost.ts`: ghost laps without rendering (`GhostRecorder`, which `Timing` runs; the packed format; `ghostPose`
  interpolation; load/save); `ghostCar.ts`: `GhostCar`, which draws `timing.ghost` as a translucent copy of the
  current car's body (cloned materials, never the shared model ones; rebuilt on car switch, re-ghosted when a model
  is swapped in) and fades it near the camera (`fade(camera)`, also called for the mirror's camera)
- `stage.ts`: renderer, scene, lights, sky, shadow-following sun, static track visuals (`buildStage`)
- `camera.ts`: `CameraRig` (camera modes; `lookBack`, set each frame from `Input.lookingBack()` (the held
  `lookBack` action or `PAD_LOOK_BACK`), turns every mode round at once: cockpit modes look back from above the body
  (`bodyBox`, measured once per cockpit, so again after a model swap), chase modes from the same distance in front)
- `mirror.ts`: `RearMirror`, the rear-view mirror (the Rear-view mirror setting). After the main render it draws the
  scene again into `#mirror`'s rectangle (viewport + scissor) from `cockpit.eye` looking back, own body hidden. The
  flip is `scene.scale.x = -1` plus `mirrorCameraPose` (three.js flips mesh winding for negative determinants, so
  culling stays right); the shadow map is not updated in the pass, the sun's `shadow.matrix` is mirrored instead.
  Nothing runs while it is hidden (setting, camera, HUD, menu, looking back, or `display: none` on narrow screens)
- `settings.ts`: setting types, menu rows (`SETTING_DEFS`: label, section, optional hint, options, `slider`),
  defaults, load/save
- `keys.ts`: keyboard actions and their two rebindable keys each (`Bindings`, saved in `localStorage`
  `fastroads.keys`, apart from the settings), `bindKey` (a key moves from whatever action had it), `keyLabel`.
  Esc (`MENU_KEY`) is fixed: it opens and closes the menu and cancels a rebind
- `catalog.ts`: what the menu shows about each circuit (`circuitInfo`: place, length and an SVG outline from the
  centreline CSV), from `TRACKS` alone; optional `country` / `lengthKm` on a `TrackDef` are used if present
- `menu.ts`: `Menu`, which talks to `main.ts` only through the `MenuHost` callbacks. A header with the main action
  (Drive, or Resume and Restart lap) and three tabs: Race (car and circuit cards, a circuit search from seven
  circuits), Settings (one section at a time) and Controls (the `controls` section's rows, key bindings, mouse and
  gamepad reference). `build()` makes the current tab's elements; a settings change only runs each item's
  `update()`, so a slider being dragged is not replaced. Keyboard: ↑ ↓ move through the items, ← → change the one
  focused (`cycle`), Enter selects; gamepad buttons arrive through `Menu.press` (`Input.pollMenuPad`)
- `hud.ts`, `minimap.ts`: in-game HUD (`Hud.update` runs every frame but writes only text/classes/styles that
  changed; its setters apply the HUD settings, `setKeys` writes the key help from the bindings); `dom.ts`: `$`
  element lookup; `tyreHud.ts`: the HUD's tyre widget (`tyreBand`: carcass temperature against the compound's
  window, the tile; `treadBand`: the tread surface's I/M/O bands (`TyreState.bandsC`) against it with 20 °C margins,
  the strip; tread number `surfaceC`), shown for a car with `Vehicle.tyres` (the LC cars: `LcCar.refresh` copies the engine's tyre and brake
  temperatures and pressures into it each tick, in place; the drift car has none)
- `main.ts`: wires it together and owns game state (the `Session`, `started`/`paused`/autopilot, the
  `applySetting` table, hotkeys, the `window.__game` hook (typed `GameHook`), the frame loop)

- **Multiplayer** (`src/net/`, `server/`, `src/multiplayer.ts` and the modules below; `docs/net.md` is the exact
  reference for the protocol, the relay, the client API and the game's rules: keep it exact). Owner-authoritative:
  each client simulates only its own car and sends its state; the others are proxies; the relay runs no physics.
  - `src/net/` (browser-safe, no DOM and no Node: the relay bundles it too): `protocol.ts` (wire format;
    `decodeMessage` never throws), `client.ts` `NetClient`, `remote.ts` `RemoteCar` (a proxy's buffer:
    extrapolation, blending, staleness), `clock.ts`, `transport.ts` / `websocket.ts` / `loopback.ts` (the emulated
    network for tests), `ids.ts`. Nothing in `src/` imports `ws`, `node:*` or `server/` (a test checks).
  - `server/`: `relay.ts` `Relay` (rooms, roster, clock, lap board, limits), `ws.ts` `listen`, `main.ts`; built by
    `vite.server.config.ts`.
  - `multiplayer.ts` `Multiplayer(net, session)`: the glue, no DOM or rendering (the tests run it as the game does).
    `tick(input, autopilot, tickAt)` replaces `session.tick`: each player's `RemoteCar` sampled at `tickAt` into a
    `ContactBody` (shape from `shapeOf`: one throwaway car per car id), put in `session.proxies` only while
    collidable; then our contacts summed into events, laps from `Timing.lastLap`, our state. `idle(now)` while paused.
    Our car is `noCollide` from joining, after each restart (`Session.resets`, which also bumps the epoch) and while
    paused, until clear of every car for `CLEAR_SECS`; the contact rule (each side applies its own half; an event is
    applied only if our simulation had no contact with that car within the window `W` about a round trip, then that
    proxy is not collided with until `W` after the hit) is in docs/net.md.
  - `remoteCars.ts` `RemoteCars`: the other cars drawn (the spec's own mesh, own material copies so one car can turn
    translucent, wheels and cockpit posed from the state), name tags (`#netLabels`, DOM), minimap dots (`MapDot`).
    `netHud.ts` `NetHud`: the board and notice feed in `#leftCol` under the timing panel. `netGame.ts`: what main.ts
    imports dynamically (`connect`, waits for the welcome), so `src/net` is not in a single-player page's download.
    `netPrefs.ts` (static, no net code): `fastroads.net` in localStorage (server, room, name), the default relay
    (`VITE_RELAY_URL` at build time, else the page's host on port 8787), the `?room=CODE&server=` link.
  - `main.ts`: a `?room=` link joins before the circuit is built, and the welcome's circuit is the one built; a menu
    join to a room at another circuit saves that circuit and reloads into `?room=`. In a room, every frame runs
    `mp.update`, the ticks go through `mp.tick` (`tickAt = now - (acc - DT)`), paused frames call `mp.idle`, a 1 s
    timer keeps the link alive while a hidden tab gets no frames, and other cars are drawn at `now - DT`. While joined
    the menu's circuit cards are locked (the room decides). The menu's Race tab has the Multiplayer section
    (`MenuHost.net`).
- **RL environment** (`src/ai/`, `ai/`, `docs/ai-env.md`, which the trainer is written from: keep it exact):
  - `src/ai/env.ts` `RaceEnv`: reset/step over a `Session` per circuit (the last `cacheSessions` kept). A step holds
    the action for `120 / actionHz` ticks of `stepPhysics`, without `Session.tick`'s restarts (a stuck or flipped
    car ends the episode: terminated). Each reset builds a fresh car (`createVehicle`; a LibreCorsa car's first
    placement is a spawn wherever it is) and clears timing (`useStore` + `reset`, events drained every tick).
    Steering goes in as `steerAngle` (share of the car's lock, `steerLockOf`), slew-limited by the env. NaN actions:
    the autopilot drives that step. `vec.ts` `VecEnv`: N of them in flat buffers, automatic resets with final obs.
  - `observation.ts`: `observe()` reads only `Vehicle` and the `Track` arrays (no Node or DOM: the browser will
    reuse it); `observationSpec()` names every element. Change both together and bump `OBS_VERSION`.
  - `walls.ts`: wall contact per tick, read from each engine (Rapier contact pairs; the LibreCorsa engine's
    telemetry over its steps, by wrapping the engine instance's `step`). `rng.ts`: seeded sfc32; no `Math.random`.
  - `protocol.ts` (pure byte layout) and `ai/worker.ts` (Node I/O; stdout carries protocol frames only).
    `vite.env.config.ts` bundles the worker with everything inline (SSR build, `noExternal`), embedding the git
    commit and dirty flag. `ai/client.mjs` / `ai/client.py`: reference clients; `ai/bench.mjs`: throughput.
  - Nothing in `src/` outside `src/ai/` imports it, so the site's bundle does not contain it.
- **Track data**: `tracks/<id>.csv` (centreline + widths, x east / y north in metres, first row at the start/finish
  line, in racing direction, ~5 m apart), loaded by `loadTrackCsv` as raw text; `parseCSV` skips `#` comment lines,
  where each file names its source. Thirteen are TUM racetrack-database files as they are; eleven (street and new
  circuits, and three whose TUM file is an older layout) are bacinger/f1-circuits GeoJSON centrelines converted by
  `scripts/tracks/convert.mjs` (its `CIRCUITS` table: start/finish spot, direction, widths, and `separate` for
  stretches the source draws closer together than the real roads). Check a converted circuit's direction and start
  line against a real map: the source does not always start at the line or run in the racing direction.
  The menu's circuit outlines are in the generated `src/trackOutlines.ts` (`catalog.ts` reads it; only the driven circuit's CSV is loaded): run `npm run tracks:outlines` after adding or changing a CSV, or `test/tracks.test.ts` fails. A new circuit is a CSV plus a `TRACKS` entry: the Circuit menu row, labels, best-times keys (`TrackDef.storeKey` +
  the car's `storeKey` suffix) and scenery follow from it. Check the start straight (pit building and stands ranges
  must sit on it), that the autopilot laps it cleanly, and how it looks. A new circuit needs its start spot
  (`startBack`) and every circuit a new car its `flying` speeds (km/h at the start spot): `npm run tracks:flying`
  prints both (see `test/flying.test.ts` under **Testing**), then the lap tests check them. Everything is
  built once at startup for `settings.track`, so changing the Circuit setting saves it and reloads the page.
  `buildTrack` turns it into a closed spline sampled every ~2 m (arrays `X, Z, TX, TZ, NX, NZ, K, S, WL, WR`, kerb/
  gravel/barrier offsets; `{ street: true }`, from `TrackDef.street`, means no gravel and walls `STREET_RUNOFF` from
  the edge). Almost everything works in track coordinates `(s, lat)` via `projectOnTrack` / `pointAt`.
- **Car specs (`CARS`)**: the cars are `lcf1` (the default; menu name "F1 2026"), `lcgt3` ("GT3") and `drift`. The ids
  of removed cars are not reused: `loadSettings` maps the saved ids of the removed Rapier cars (`f1`, `gt3`) to their
  LibreCorsa twins. Each spec holds every physics, engine, gearbox, steering, collider, camera, sound and autopilot
  number for its car, plus its mesh builder, its engine voice (`sound`, an `EngineVoice` from `audioGraph.ts`),
  its lap-time `storeKey`, and its menu card (`blurb`, `powerKw`). The `Car` class reads only `this.spec`, so a new Rapier car is a new spec entry
  (`test/cars.test.ts` checks each spec fits the menu, gearbox, mesh and autopilot). The drift car is the only car on
  our physics; each of its handling features has a neutral value that turns it off for another car (`brakeKick: 0`,
  `brakeGrip: 1`, `driveGrip: 1`, `rearLoose` share 0, `rearCatch` extra 0, `counterLock: [0, 1]`, `spinLat: 0`,
  `spinDrive: 0`, `yawCap` gain 0, `counterSteer` gain 0, `autoCounter: 0`, `autoLift: 0`, no `pacFront`).
  `autoUndersteer` (on `CarInfo`) is extra autopilot lock for a car that understeers (the GT3's 0.0025).
  `forceHeight` (0.12 on the drift car) is how far above the road the tyres' grip acts on the body: it cuts their
  load transfer to that of a lower centre of mass (0 is full load transfer).
- **Two engines**: every car spec is a `CarInfo` (what the game outside the physics reads: menu, body geometry,
  HUD/sound engine numbers, cameras, the autopilot's plan inputs) with a `physics` discriminant. `CarSpec` (`'rapier'`)
  adds our physics numbers; `LcSpec` (`'lc'`) adds a LibreCorsa car config and driver. `createVehicle` in `sim.ts`
  builds the right class; `stepPhysics` calls `car.step`, steps the Rapier world only for Rapier cars, then
  `car.readState`. Code outside `car.ts` must use `Vehicle` / `CarInfo`, never `Car` / `CarSpec`.
- **LibreCorsa engine (`src/lc/`)**: the `lcgt3` and `lcf1` cars (menu names "GT3", "F1 2026"; the ids and their
  best-times `storeKey`s keep the `lc` from when Rapier twins of both existed).
  - `lc/vendor/`: LibreCorsa's car physics (`VehiclePhysics`, github.com/KhazP/librecorsa, MIT) and the two cars'
    data, copied nearly verbatim. Do not edit it except to re-vendor: its README lists the upstream commit, the
    files and the four edits (one removes third-party CC BY-NC-SA rain-tyre data; keep it out). The engine runs
    fixed 2 ms steps, has its own rigid body and wall response, and has no ABS, TC or input shaping.
  - `lc/lcCar.ts`: `LcCar implements Vehicle`. Each 120 Hz tick runs 4 or 5 engine steps (25 per 6 ticks, counted in
    integers so it never drifts), with the driver around each. It owns our gearbox conventions (reverse as in the
    gearbox under **Car physics**, one manual shift per tick, `shiftDenied`, neutral), the F1's flaps (open by themselves in
    `straightWindows`: straights of 250 m+) and lap energy (`locateProgress`), and maps engine state to ours.
    A new car's first placement (wherever: the RL environment places fresh cars anywhere), and `placeAt` on that
    first-placement spot again (the start spot, which is the only place the session puts it), builds a
    fresh engine instance (full battery, fuel; cheap because the engine memoises that settle),
    rolling at the given speed through the engine's own rolling start; anywhere else (tests) it is a teleport that
    keeps battery and lap energy (20–40 ms: the engine settles the car by simulating). The start spot is before
    the last corners, so the F1 crosses the line with what the run-up left in the battery (48% at Albert Park; a
    lap leaves it at its 20% floor, so a restart's lap still starts better off than a second lap); the per-lap
    energy allowances reset at the line, where the progress wraps. Either way the tyres and
    brakes are fresh, the discs at their start temperature and the tyres not in their blankets but at the heat of a
    lap (`warmTyres`: `LcSpec.warmTyres`, every band's surface, bulk and core node per axle, the autopilot's at the
    start spot after seven laps; the pressure by the engine's gas law), written before the engine's `reset` with
    `keepTyres`, so its settle runs on them and the memo still applies. Of the engine's tyre model, heat (surface, carcass, I/M/O bands),
    pressure and brake-disc heat are live and change grip; wear, graining, blistering and flat spots are off
    (`realism.tyreWearScale: 0` in `build`), and fuel is not burnt (that is LibreCorsa's game adapter's job, not
    the engine's): turning any of it on moves the pinned laps.
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
    is -1, as ours. Its box has no neutral: ours (gear 0) holds its clutch open (`inp.clutch`), with its box kept in
    a forward gear that fits the road speed.
- **Car physics (`Car.step`)**: Rapier rigid body at a fixed 120 Hz (`DT`), with custom physics on top:
  - raycast suspension with anti-roll bars
  - Pacejka lateral curve with load sensitivity (`pac`, and `pacFront` for the fronts)
  - friction circle with ABS-style brake priority, stretched along the wheel by `brakeGrip` / `driveGrip`
  - optional countersteer assist for the player's steering (`counterSteer`, enabled by `car.assist` from the
    Countersteer assist setting, off by default); the autopilot's `steerAngle` bypasses it, so assist tuning does
    not move the pinned lap times
  - traction control (`tcSlack`)
  - gearbox: `gear` is -1 reverse, 0 neutral (manual only: below first at any speed; reverse is below it at a
    standstill), 1.. forward. A manual downshift that would pass `overRev` is refused at once and sets
    `shiftDenied`; `LcCar` applies the engine's own test. Reverse, on both engines: in the manual box it is selected
    and left only by the shifts, and in R the throttle drives backwards and the brake brakes. The automatic box
    (also the autopilot's, `autoGears`) selects R when the brake is held at a standstill (0.35 s); in that R the
    pedals swap (the brake drives backwards, the throttle brakes), and the throttle below 1 m/s backwards selects
    first. `car.throttle` / `car.brake` are the pedals as applied (after the swap), which the HUD bars, brake light,
    sound and cockpit display show
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
- **Settings and menu**: `settings.ts` has the `Settings` type, `SETTING_DEFS` (menu rows, their section and order) and
  `DEFAULT_SETTINGS`; `main()` has the `applySetting` table (what each setting does). `setSetting` saves to
  `localStorage` `fastroads.settings` and calls `applySetting`; in-game hotkeys go through `cycleSetting` so the menu
  stays in sync. Adding a setting means adding it to all four; the compiler flags any you miss. Saved settings from
  older versions load with the newer keys at their defaults; a value not among a setting's options (sliders
  included: their options are the listed numbers) falls back to the default. `nextOption` wraps buttons round and
  stops sliders at their ends. What the settings reach: `CameraRig` (`fovOffset`, `speedFov`, `shake`), `Hud`
  setters, the stage's `setResolution` / `setShadows` / `setBrightness`, and `EngineAudio.setVolume` (a gain node of
  its own between the sound graph and the speakers; there are no per-sound volumes).
- **Timing**: start/finish and two sector lines as segments, with crossings interpolated within a tick; track-limit
  invalidation, which in the run-up (the last `startBack` m before the line: from the start spot, or at the end of
  a lap) deletes the next lap too (`nextInvalid`, the `invalid` event's `laps`; a restart forgives it); best lap/sectors/trace stored per circuit and car under `TrackDef.storeKey + spec.storeKey`
  (`useStore` switches). Every lap is recorded (`GhostRecorder`, 10 Hz, from the pose just before the line to the
  end of the tick the lap ended in); a new valid best lap's recording becomes `timing.ghost` and is saved under the
  same key + `.ghost` (base64, after the best times, so a full storage loses only the ghost), and is loaded only if
  its lap time is the stored best lap. `clearStore` (Reset best times) removes both. The ghost plays at the lap time
  the car is drawn at (`simTime - (1 - alpha) * DT - lapStart`), which keeps it level with the car when the delta is 0.
- **Input**: keyboard, gamepad and visible-cursor mouse steering (cursor x relative to screen centre, with
  sensitivity/deadzone settings) merge in `Input.poll` into one input object. `input.mouse.active` is set each frame
  by the game loop (driving, not paused or in the menu). Driving keys come from `input.bindings`; one-shot actions
  are read with `input.takeAction(action)`, which also sees the gamepad buttons (`PAD_BUTTONS`) and the mouse wheel
  (they add `act:<action>` to `pressed`). The key help in the HUD and the Controls tab are made from the bindings,
  so they always match them.
- **Autopilot**: pure pursuit on the centreline plus a speed profile from `buildSpeedProfile(track, spec)`, cached
  per car on `track.speedProfiles`. Within 1.5 m of the edge on the outside of a bend it lifts (the drift car slides
  wide under power in fast sweepers such as Monza's Curva Grande); no lap at Melbourne or Silverstone gets that close,
  so their pins did not move. Brake-marker boards are scenery and are always placed from the `lcf1` profile.
