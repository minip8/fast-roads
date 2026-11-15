# Fast Roads

Browser time-trial racer on real circuit layouts. Prototype covering build steps 1–3:
two circuits (Albert Park in Melbourne and Silverstone), three cars (a downforce open-wheel car, a rear-drive drift car and a GT3 coupe), and lap/sector
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
steering (keyboard/mouse), camera, traction control, countersteer assist (drift car), and sound. Settings are remembered. Choosing another circuit reloads the game onto it. Your best lap for the chosen car and circuit is shown, with a
**Reset best times** option (click twice to confirm). While driving, **Esc** or **P** opens it as a pause menu
(Resume / Restart session). Mouse or keyboard (↑ ↓ ← → Enter) both work in the menu.

## Cars

- **F1**: light, huge downforce and grip, 8 gears, 12,500 rpm. Stable and fast.
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

- **GT3**: a 1,385 kg front-engined V8 coupe on slicks, with a splitter, diffuser and rear wing. It is the
  Mercedes-AMG GT3 of [LibreCorsa](https://github.com/KhazP/librecorsa), an open-source simulator whose GT3 is fitted
  to real GT3 telemetry: the mass, wheelbase, weight distribution, springs, anti-roll bars, tyre data, brakes, engine,
  gearing and downforce are that car's numbers, run through this game's physics. Driven through the manoeuvres
  LibreCorsa measures its own car with, it lands on the same figures (`test/gt3.test.ts`):

  | | Speed (km/h) | Here | LibreCorsa | Real car |
  | --- | --- | --- | --- | --- |
  | Cornering (g) | 81 / 99 / 117 / 153 / 171 | 1.71 / 1.75 / 1.79 / 1.90 / 1.95 | 1.71 / 1.75 / 1.80 / 1.92 / 1.98 | 1.70 / 1.79 / 1.79 / 2.13 / 2.01 |
  | Braking (g) | 99 / 117 / 153 / 189 / 225 / 243 | 1.76 / 1.82 / 1.94 / 2.04 / 2.15 / 2.18 | 1.66 / 1.77 / 1.95 / 2.11 / 2.17 / 2.18 | 1.68 / 1.72 / 1.83 / 2.03 / 2.11 / 2.12 |
  | Full throttle (g) | 63 / 99 / 135 / 171 / 207 / 243 | 0.82 / 0.84 / 0.61 / 0.44 / 0.31 / 0.19 | 0.85 / 0.83 / 0.60 / 0.43 / 0.31 / 0.20 | 0.95 / 0.77 / 0.64 / 0.45 / 0.30 / 0.19 |
  | Understeer (°/g) | | 1.40 | 1.42 | 1.44 |

  The real-car column is what LibreCorsa extracted from GT3 telemetry logs. Understeer is the extra steering the car
  needs for every g it corners at, which is what makes it feel heavy and calm next to the F1. 0–100 km/h takes
  3.6 s, 0–200 km/h 9.5 s, top speed is about 308 km/h, and it stops from 100 km/h in 23 m.
  - **It runs out of front grip first.** Too fast into a corner and the nose pushes wide; the tail stays behind you.
    A held steering key corners near the limit at any speed, and braking while turning stays stable.
  - **The tyres peak early and stay there.** Grip peaks at about 6° of slip (the F1's at about 10°) and then falls
    only to 85%, so over-driving costs time rather than the car.
  - **Power does not spin it.** With traction control on or off, full throttle from the middle of a corner pushes
    the nose wide instead of swinging the tail. LibreCorsa's car can be spun on the power with its traction control
    off; this game has no wheelspin model, so that part of its handling is missing here.
  What is not carried over: tyre temperature, pressure and wear, suspension geometry, the limited-slip differential,
  ride-height-dependent downforce and wet weather. The body is this game's own; LibreCorsa's car model is not used.

Each car keeps its own best lap and sector times at each circuit. Switching car puts you back on the grid.

## HUD

Bottom right: F1-style shift lights (5 green, 5 red, 5 blue) fill towards the shift point and all flash there
(where the automatic box shifts up: 12,250 rpm in the F1, 7,200 in the drift car, 7,500 in the GT3); throttle (green) and brake (red) bars show how hard each pedal is
applied; then the gear and speed.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake (hold when stopped to reverse, up to ~40 km/h; W then brakes) |
| A D / ← → | Steer |
| R | Reset to track (invalidates the lap) |
| Enter | Restart session at the grid |
| V | Mouse steering on/off (also in the menu) |
| C | Cycle camera (onboard / chase / far) |
| G | Automatic / manual gears (also in the menu) |
| E / Q | Shift up / down (manual) |
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
- **Physics**: Rapier rigid body (fixed 120 Hz step, interpolated rendering). Custom raycast suspension with
  anti-roll bars, simplified Pacejka lateral curve with load sensitivity, friction circle, downforce and drag ∝ v²,
  torque curve + 8-speed gearbox (automatic, or manual with over-rev-protected downshifts), per-surface grip. Walls are static cuboid colliders.
  The GT3 swaps in a brush tyre curve with power-law load sensitivity, steering that flexes under cornering force,
  and the inertia of its engine and wheels (which takes about a tenth of its push in first gear).
  Grass has about 64% of the asphalt's grip and gravel about half. Both add a ploughing deceleration (grass ~0.08 g,
  gravel ~0.6 g) that's applied mostly at the centre of mass, so dropping two wheels off doesn't yank the car round,
  and it fades below ~90 km/h so you can drive out: flat out, the F1 still reaches ~200 km/h on grass and ~80 km/h
  on gravel.
  Grip eases between surfaces over ~0.1 s instead of switching instantly at the track edge.
  Off-track you get a grass rumble or gravel crunch and dust behind the wheels (visual only; the body stays steady).
- **Sound**: all synthesised with Web Audio, no samples. Each car has its own engine voice (a smooth V6 in the F1, a
  lumpy V8 in the drift car, a harder, brighter V8 in the GT3) that brightens under load, cuts briefly on upshifts, blips on downshifts and stutters on
  the rev limiter. Tyres squeal as they near the limit of grip on asphalt and kerbs (cornering or wheelspin), which is
  the cue to catch a slide; kerbs rumble at the strip rate, road and wind noise rise with speed, and hard impacts
  thud. Sound starts on the first click or key press (browser autoplay rules), fades out while paused, and stops
  while muted or in a background tab.
- **Timing**: start/finish + two sector lines as segments; crossings are detected per tick and interpolated within
  the tick. A lap is deleted if all four wheels pass the kerb (or white line where there's no kerb), on reset, or when
  crossing a line backwards. Best lap, best sectors, and the best-lap trace (for the live delta) persist in localStorage.
- **Brake markers**: 300/200/100 m boards before every braking zone where the speed drops by more than ~50 km/h,
  counting down to the turn-in point. Zones are found from the autopilot's speed plan; boards are skipped when they'd
  fall inside the previous corner.

Combined grip works like ABS: cornering force keeps priority and the brakes get the remaining grip (never less than 45%),
so you can trail-brake into corners. The rear tyres have 10% more grip and the aero balance sits behind the weight
distribution, so the car understeers gently at the limit instead of spinning.

Measured car performance: 0–100 km/h 2.5 s, 0–200 km/h 4.8 s, top speed ~325 km/h, ~3.6 g average braking from top speed,
steady-state lateral grip 1.3 g at 60 km/h rising to 3.5 g at 260 km/h.

Tests (`npm test`) run the same physics headless in Node and check autopilot lap times to the millisecond, so any
change to handling shows up. In the browser, `window.__game.simulate(seconds, true)` does the same with the autopilot.

## Not yet

Elevation (Albert Park is flat and Silverstone nearly so; Spa/COTA will need SRTM data), pit lane, ghosts, leaderboards, multiplayer.

Track data: [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) (LGPL-3.0).
GT3 car data and reference measurements: [KhazP/librecorsa](https://github.com/KhazP/librecorsa) (MIT).
