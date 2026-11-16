# Fast Roads

Browser time-trial racer on real circuit layouts. Prototype covering build steps 1–3:
two circuits (Albert Park in Melbourne and Silverstone), three cars (a 2026 F1 car and a GT3 on LibreCorsa's physics engine, and a rear-drive drift car on the game's own physics), and lap/sector
timing with track limits.

## Run

Needs Node.js. Install once, then start the dev server and open the URL it prints:

    npm install
    npm run dev        # dev server with live reload
    npm test           # headless physics tests (lap times, handling)
    npm run build      # type-check + static build in dist/ (host anywhere; `npm run preview` serves it locally)

The built game works from any sub-path of any static host, and keeps working offline after the first visit: a small
service worker (`src/sw.js`, production builds only) caches the build; the page itself is always fetched fresh when
online, so a new deploy shows up on the next load.

For development, append `?autopilot` to the URL to skip the menu and watch the built-in driver lap the circuit.
The autopilot isn't part of the game itself.

## Main menu

The game opens on a menu: **Drive**, plus settings for circuit, car, gears (automatic/manual),
steering (keyboard/mouse), camera, driver camera hands, traction control, countersteer assist (drift car), and sound. Settings are remembered. Choosing another circuit reloads the game onto it. Your best lap for the chosen car and circuit is shown, with a
**Reset best times** option (click twice to confirm). While driving, **Esc** or **P** opens it as a pause menu
(Resume / Restart lap). Mouse or keyboard (↑ ↓ ← → Enter) both work in the menu.

Cameras: **Onboard** (above the F1's airbox, on the other cars' bonnets), **Driver** (from the driver's eyes, with
the cockpit, steering wheel and the driver's arms; the wheel turns with the road wheels at each car's steering
ratio), **Chase** and **Far**. Every car carries a driver, visible from outside too. The driver's arms and gloves
are hidden in the Driver camera unless **Driver camera hands** is set to Shown (they always show from outside).

## Cars

- **Drift car**: a light (1,000 kg) rear-drive coupe with almost no downforce and a torquey 7,500 rpm V8 in 6 gears:
  0–100 km/h in about 2.9 s, about 1.2 g of cornering grip. It is tuned for smooth slides on mouse or stick
  steering:
  - **The throttle slides it.** At cornering speeds the rear gives up grip under power (and, less so, when you steer
    into a corner); it firms up towards top speed so the straights stay stable. Turning in on the throttle swings
    the tail 20° out in about a second, at no more than about 40°/s.
  - **The slide settles and holds.** Past about 15° of slide the rear starts to dig in, so a slide settles at about
    30° and stays there for as long as the throttle is down, with the wheel straight or on a little opposite lock.
  - **It keeps its speed.** Spinning rear tyres keep most of their cornering force and still push the car forward,
    so a held slide stays at about 80–100 km/h and the car's path follows its nose.
  - **Lifting ends it.** Off the throttle the rear gets its grip back and the car is straight in about a second.
  - **No whip.** The car cannot rotate much faster than it can corner, so flicking from a left slide to a right one
    swings the tail to about 40° the other way rather than round into a spin.
  Steering chooses the line more than the angle: opposite lock runs a wider, faster arc, steering in a tighter,
  slower one. On the keyboard, opposite lock follows the slide angle instead of going to full lock. Braking while
  turning still kicks the tail out. Its traction control is lenient; with TC on or off it slides much the same.
  Nothing steers for you unless you turn on **Countersteer assist** in the menu (off by default). It stops at about
  1.4 g, 100 km/h to rest in under 30 m. It uses a bonnet camera for the onboard view.

- **F1 2026** and **GT3**: the 2026 F1 car and the Mercedes-AMG GT3 of [LibreCorsa](https://github.com/KhazP/librecorsa),
  an open-source simulator whose GT3 is fitted to real GT3 telemetry, running on LibreCorsa's physics engine itself
  (`src/lc/vendor/`, MIT) in place of this game's: a 500 Hz rigid body with brush tyres that
  heat up, double-wishbone suspension solved from its hardpoints, a limited-slip differential, an engine, clutch
  and gearbox with their own inertia, brakes that heat, and downforce that changes with ride height. On flat ground
  the vendored engine gives the same numbers as LibreCorsa's own code to four decimals (`test/lc-engine.test.ts`).
  - **The wheels really spin and lock.** The engine has no driver aids of its own, so the game adds LibreCorsa's:
    ABS (always on) and traction control (the menu's setting). With traction control off, a held throttle swings
    the GT3's tail 20° out mid-corner and spins the F1 out of slow corners.
  - **Tyres start in their blankets** (60 °C on the GT3, 80 °C on the F1) and come up to temperature over the first
    corners; a restart fits fresh ones (and gives the F1 a full battery). They do not wear and no fuel is burnt.
  - **The F1's hybrid and flaps work themselves.** The battery deploys and harvests by itself (its "race" mode,
    with the per-lap energy allowance of the 2026 rules), and the front and rear flaps open on every straight of at
    least 250 m while the throttle is down and close on the brakes.
  - **Steering depends on the device.** Keys go through LibreCorsa's keyboard assist, which turns in at a rate set
    by speed and holds the front tyres just under their peak slip: a held key corners at 94–100% of the limit
    without spinning. Mouse and stick go straight to the steering rack, as in LibreCorsa, with no scaling for
    speed: full deflection is always full lock (25° on the GT3, 19° on the F1). The tyres' peak sits well inside
    that, and further in the faster you go: at about 40% of the travel at 80 km/h on the GT3 and 30% from 150 km/h,
    and on the F1 at about 53% at 80 km/h, 33% at 150 and 27% at 220. Past it the GT3 scrubs its front tyres and the
    F1 spins, so at speed steer with small movements (a lower Mouse sensitivity spreads them over more of the
    screen). Pedals from keys and mouse buttons are eased on over about 0.2 s.
  - **Numbers** (measured in the tests): GT3 0–100 km/h 3.5 s, 1.9 g braking from 200 km/h, 1.6–2.0 g cornering
    from 80 to 220 km/h; F1 0–100 km/h 2.7 s, 2.9 g braking from 200 km/h, 2.0–3.9 g cornering from 80 to 220 km/h.
  The GT3 is VTX's Red Bull Racing Mercedes-AMG GT3 model (see Credits); the F1 2026 has a body built in code. Not
  used from LibreCorsa: weather, tyre
  wear, fuel use, damage, car setup, the F1's manual boost and energy modes, and its car models and sounds.

Each car keeps its own best lap and sector times at each circuit. Switching car puts you back at the start.

**Every lap is a flying lap.** You start on the straight before the start/finish line (160 m back at Albert Park,
60 m at Silverstone), already at the speed the car reaches there on a lap and in the gear for it, so keep the
throttle down: the lap starts as you cross the line. **R** (or Enter, or Restart lap in the menu) puts you back
there at any time and drops the lap you were on; so does the game when the car ends up on its roof. The start
speed is fixed per car and circuit (232 km/h for the F1 2026 at Albert Park, 151 km/h out of Club at Silverstone), so
every attempt begins the same way.

## HUD

Bottom right: F1-style shift lights (5 green, 5 red, 5 blue) fill towards the shift point and all flash there
(where the automatic box shifts up: 12,200 rpm in the F1 2026, 7,500 in the GT3, 7,200 in the drift car); throttle (green) and brake (red) bars show how hard each pedal is
applied; then the gear and speed.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake (hold when stopped to reverse, up to ~40 km/h; W then brakes) |
| A D / ← → | Steer |
| R / Enter | Restart the lap: back before the line at flying-lap speed |
| V | Mouse steering on/off (also in the menu) |
| C | Cycle camera (onboard / driver / chase / far) |
| G | Automatic / manual gears (also in the menu) |
| E / Q | Shift up / down (manual): reverse, neutral, first... A downshift that would over-rev is refused |
| T | Traction control on/off |
| Esc / P | Open the menu (pauses) |
| M / H | Mute / hide help |

Gamepad: RT throttle, LT brake, left stick steer, RB/LB shift up/down, Y camera, X reset.

Mouse steering: the cursor stays visible, and how far it is left or right of the screen centre sets the wheel
(in direct proportion, reaching full lock towards the edge). Mouse sensitivity (Low / Medium / High) in the menu sets how far
you need to go, and Mouse deadzone (Off / Small / Medium / Large) sets how wide the do-nothing zone around the
centre is. Left click is throttle, right click is brake, scroll shifts gears in manual. Steering keys still work
and override the mouse while held.

## How it works (TypeScript in `src/`, one module per area)

- **Circuits**: Albert Park (5.30 km) and the Silverstone Grand Prix layout (5.89 km, starting on the Hamilton
  Straight). Each is a TUM centerline + widths CSV (`tracks/*.csv`, bundled at build time; `src/tracks.ts` lists them
  with their grid spot and scenery) → Catmull-Rom → resampled every ~2 m.
  Kerbs, gravel traps, and barrier offsets are derived from curvature; barriers are shrunk/dropped where they'd
  intrude on another part of the circuit. Road, kerbs, gravel, and walls are ribbon meshes built from the samples.
- **Physics** (the drift car): Rapier rigid body (fixed 120 Hz step, interpolated rendering). Custom raycast suspension with
  anti-roll bars, simplified Pacejka lateral curve with load sensitivity, friction circle, downforce and drag ∝ v²,
  torque curve + gearbox (automatic, or manual with a neutral and over-rev-protected downshifts), per-surface grip. Walls are static cuboid colliders.
  Grass has about 64% of the asphalt's grip and gravel about half. Both add a ploughing deceleration (grass ~0.08 g,
  gravel ~0.6 g) that's applied mostly at the centre of mass, so dropping two wheels off doesn't yank the car round,
  and it fades below ~90 km/h so you can drive out.
  Grip eases between surfaces over ~0.1 s instead of switching instantly at the track edge.
  Off-track you get a grass rumble or gravel crunch and dust behind the wheels (visual only; the body stays steady).
- **Second physics engine**: the F1 2026 and the GT3 run LibreCorsa's car physics, vendored nearly verbatim in `src/lc/vendor/`
  (its README lists the files, the upstream commit and the few edits). The game sees every car through one
  interface (`src/vehicle.ts`); `src/lc/lcCar.ts` adapts the engine to it, running four or five of the engine's 2 ms
  steps per 120 Hz game tick. The engine meets the same track as the other cars: `src/lc/ground.ts` answers its
  ground queries from the circuit's surfaces (its own grip and drag for road, kerb, grass and gravel) and gives it
  the barriers as wall segments. `src/lc/driver.ts`, `aids.ts` and `steering.ts` are ports of the parts of
  LibreCorsa's game layer that the engine relies on: pedal ramps, the keyboard steering assist, ABS and traction
  control, all run at the engine's 500 Hz. One game tick costs about half a millisecond for these cars.
- **Car bodies**: built from boxes and extrusions in code (`src/carMeshes.ts`), each with a seated driver whose
  hands turn the steering wheel in the driver camera. The GT3 instead shows a 3D model (`public/cars/lcgt3/`, about
  4.3 MB, 155k triangles, most of them in the cabin): the built body shows until the model has downloaded, and stays if it can't.
  `scripts/cars/convert.mjs` makes it from the Sketchfab download (turned, scaled to the car's axles, split into
  body, wheels, calipers, steering wheel and brake lights, simplified, WebP textures, meshopt geometry). The
  service worker keeps the model once it has been downloaded rather than precaching it.
- **Sound**: all synthesised, no recordings. Each car has its own engine voice (a smooth V6 in the F1, a lumpy V8 in
  the drift car) that brightens under load, cuts briefly on upshifts, blips on downshifts and stutters on the rev
  limiter. The voices get their weight from the spectrum, not from a lower pitch: crank orders under the firing note
  (the half orders that make a V8 rumble), a low exhaust/body resonance and low shelf, and little upper-mid buzz. The GT3's cross-plane V8 is made the way sample-based sims do it, with samples we synthesise ourselves
  (`src/engineLoops.ts`): exhaust pulses in the 1-5-4-8-6-3-7-2 firing order through each bank's pipe, with
  combustion noise, saturation and a low body resonance, rendered into seamless loops at six rpm points on load and on the overrun, then
  crossfaded by rpm and throttle with their pitch following the rpm. It burbles off the throttle, barks on it, pops
  and crackles on the overrun, and has a straight-cut gear whine that follows road speed. The loops take about
  0.1 s to make, one per frame, the first time a GT3 is driven. Tyres squeal as they near the limit of grip on asphalt and kerbs (cornering or wheelspin), which is
  the cue to catch a slide; kerbs rumble at the strip rate, road and wind noise rise with speed, and hard impacts
  thud. Sound starts on the first click or key press (browser autoplay rules), fades out while paused, and stops
  while muted or in a background tab.
- **Timing**: start/finish + two sector lines as segments; crossings are detected per tick and interpolated within
  the tick. A lap is deleted if all four wheels pass the kerb (or white line where there's no kerb) or when
  crossing a line backwards; a restart drops the lap under way. Best lap, best sectors, and the best-lap trace (for the live delta) persist in localStorage.
- **Brake markers**: 300/200/100 m boards before every braking zone where the speed drops by more than ~50 km/h,
  counting down to the turn-in point. Zones are found from the autopilot's speed plan; boards are skipped when they'd
  fall inside the previous corner.

Tests (`npm test`) run the same physics headless in Node and check autopilot lap times to the millisecond, so any
change to handling shows up. In the browser, `window.__game.simulate(seconds, true)` does the same with the autopilot.

## Credits

- **GT3 body**: "Mercedes-AMG GT3 Red Bull Racing" by VTX
  ([Sketchfab](https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba)),
  based on "Mercedes-Benz AMG GT3 Red Bull" by toddeppe
  ([Sketchfab](https://sketchfab.com/3d-models/mercedes-benz-amg-gt3-red-bull-83c34fe5c0d64d838bc3c5e0f2d7f56a)),
  itself derived from "Mercedes-AMG GT3 | www.vecarz.com" by [Vecarz](https://www.vecarz.com)
  ([Sketchfab](https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07)).

All three are licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); the converted
file (`public/cars/lcgt3/model.glb`) is an adaptation under the same licence, which is not the code's: the
`LICENSE.md` beside it lists the changes made. Because of it **the game as distributed is non-commercial**
(remove the model, and the GT3 falls back to its built body). The Red Bull livery's names and logos, and
the Mercedes-AMG and Mercedes-Benz names and star, are trademarks of their owners; the model is unofficial and
the game is not affiliated with or endorsed by Mercedes-AMG, Mercedes-Benz or Red Bull.

- **LibreCorsa** (github.com/KhazP/librecorsa, MIT): the physics engine and car data in `src/lc/vendor/` (licence
  and provenance in its README) and the ports of its driver aids in `src/lc/`.
- **Keyboard steering assist** (`src/lc/steering.ts`): ported from LibreCorsa's, which is adapted from
  [AC-Advanced-Gamepad-Assist](https://github.com/adam10603/AC-Advanced-Gamepad-Assist) v1.5.5 by Adam D.
  (@adam10603), under the MIT licence:

  > Copyright (c) 2023 Adam D.
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  > documentation files (the "Software"), to deal in the Software without restriction, including without limitation
  > the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
  > to permit persons to whom the Software is furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all copies or substantial portions
  > of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
  > THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
  > CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
  > IN THE SOFTWARE.

## Not yet

Elevation (Albert Park is flat and Silverstone nearly so; Spa/COTA will need SRTM data), pit lane, ghosts, leaderboards, multiplayer.

Track data: [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) (LGPL-3.0).
The physics engine and the F1 2026 and GT3 car data:
[KhazP/librecorsa](https://github.com/KhazP/librecorsa) (MIT; see `src/lc/vendor/README.md`).
