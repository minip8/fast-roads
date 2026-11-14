# Fast Roads

Browser time-trial racer on real circuit layouts. Prototype covering build steps 1–3:
one circuit (Albert Park, Melbourne), two cars (a downforce open-wheel car and a rear-drive drift car), and lap/sector
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

The game opens on a menu: **Drive**, plus settings for car, gears (automatic/manual),
steering (keyboard/mouse), camera, traction control, countersteer assist (drift car), and sound. Settings are remembered. Your best lap for the chosen car is shown, with a
**Reset best times** option (click twice to confirm). While driving, **Esc** or **P** opens it as a pause menu
(Resume / Restart session). Mouse or keyboard (↑ ↓ ← → Enter) both work in the menu.

## Cars

- **F1**: light, huge downforce and grip, 8 gears, 12,500 rpm. Stable and fast.
- **Drift car**: a heavy rear-drive coupe with almost no downforce and a torquey 7,500 rpm V8 in 6 gears
  (0–100 km/h in about 3.9 s, about 1.2 g of cornering grip). It is oversteery: at cornering speeds the rear gives up grip whenever you ask the car
  to rotate, by steering into a corner or by using the throttle (it firms up towards top speed so the straights
  stay stable), and it steps out further when you brake while turning. Turning in off the throttle puts the tail
  about 20° out within a second. Lifting off and straightening the wheel, or steering into the slide, gives the
  rear its grip back, so that is how a slide is caught; opposite lock and feathering the throttle holds one.
  Spinning the rear wheels costs little cornering force, so in a power slide the car keeps turning (its path
  follows its nose) rather than gaining speed. Its
  traction control is lenient, so the throttle can still swing the rear with TC on; turn it off (T) for big slides.
  Nothing steers for you unless you turn on **Countersteer assist** in the menu (off by default): with it, the
  front wheels turn into a slide by themselves, and holding the steering key settles into a drift at about 30°
  instead of a spin. It stops at about 1.4 g, 100 km/h to rest in under 30 m. It uses a
  bonnet camera for the onboard view.

Each car keeps its own best lap and sector times. Switching car puts you back on the grid.

## HUD

Bottom right: F1-style shift lights (5 green, 5 red, 5 blue) fill towards the shift point and all flash there
(where the automatic box shifts up: 12,250 rpm in the F1, 7,200 in the drift car); throttle (green) and brake (red) bars show how hard each pedal is
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

- **Track**: TUM centerline + widths (`tracks/melbourne.csv`, bundled at build time) → Catmull-Rom → resampled every ~2 m.
  Kerbs, gravel traps, and barrier offsets are derived from curvature; barriers are shrunk/dropped where they'd
  intrude on another part of the circuit. Road, kerbs, gravel, and walls are ribbon meshes built from the samples.
- **Physics**: Rapier rigid body (fixed 120 Hz step, interpolated rendering). Custom raycast suspension with
  anti-roll bars, simplified Pacejka lateral curve with load sensitivity, friction circle, downforce and drag ∝ v²,
  torque curve + 8-speed gearbox (automatic, or manual with over-rev-protected downshifts), per-surface grip. Walls are static cuboid colliders.
  Grass has about 64% of the asphalt's grip and gravel about half. Both add a ploughing deceleration (grass ~0.08 g,
  gravel ~0.6 g) that's applied mostly at the centre of mass, so dropping two wheels off doesn't yank the car round,
  and it fades below ~90 km/h so you can drive out: flat out, the F1 still reaches ~200 km/h on grass and ~80 km/h
  on gravel.
  Grip eases between surfaces over ~0.1 s instead of switching instantly at the track edge.
  Off-track you get a grass rumble or gravel crunch and dust behind the wheels (visual only; the body stays steady).
- **Sound**: all synthesised with Web Audio, no samples. Each car has its own engine voice (a smooth V6 in the F1, a
  lumpy V8 in the drift car) that brightens under load, cuts briefly on upshifts, blips on downshifts and stutters on
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

Elevation (Albert Park is flat; Spa/COTA will need SRTM data), pit lane, ghosts, leaderboards, multiplayer.

Track data: [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) (LGPL-3.0).
