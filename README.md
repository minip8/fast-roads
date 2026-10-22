# Fast Roads

Browser time-trial racer on real circuit layouts. Prototype covering build steps 1–3:
one circuit (Albert Park, Melbourne), a downforce open-wheel car, and lap/sector timing with track limits.

## Run

Open `index.html` in a browser (Chrome/Firefox/Edge). It loads three.js and Rapier from the jsDelivr CDN,
so it needs an internet connection. To serve it locally instead:

    python3 -m http.server 8000   # then open http://localhost:8000

Append `?autopilot` to the URL to watch the built-in driver lap the circuit.

## Main menu

The game opens on a menu: **Drive** or **Watch autopilot**, plus settings for gears (automatic/manual), steering
(keyboard/mouse), camera, traction control, and sound. Settings are remembered. Your best lap is shown, with a
**Reset best times** option (click twice to confirm). While driving, **Esc** or **P** opens it as a pause menu
(Resume / Restart session / Watch autopilot). Mouse or keyboard (↑ ↓ ← → Enter) both work in the menu.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake (hold when stopped to reverse) |
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
| O | Autopilot on/off |

Gamepad: RT throttle, LT brake, left stick steer, RB/LB shift up/down, Y camera, X reset.

Mouse steering: click the game to capture the mouse, then move left/right to turn the wheel (it stays where you
leave it; ~350 px from centre is full lock). Left click is throttle, right click is brake, scroll shifts gears in
manual, middle click centres the wheel. Esc releases the mouse and pauses; click to resume. Steering keys still work
and override the mouse while held.

## How it works (all in `index.html`)

- **Track**: TUM centerline + widths (`tracks/melbourne.csv`, embedded in the page) → Catmull-Rom → resampled every ~2 m.
  Kerbs, gravel traps, and barrier offsets are derived from curvature; barriers are shrunk/dropped where they'd
  intrude on another part of the circuit. Road, kerbs, gravel, and walls are ribbon meshes built from the samples.
- **Physics**: Rapier rigid body (fixed 120 Hz step, interpolated rendering). Custom raycast suspension with
  anti-roll bars, simplified Pacejka lateral curve with load sensitivity, friction circle, downforce and drag ∝ v²,
  torque curve + 8-speed gearbox (automatic, or manual with over-rev-protected downshifts), per-surface grip. Walls are static cuboid colliders.
  Grass and gravel add a ploughing deceleration (grass ~0.15 g, gravel ~1 g) that's applied mostly at the centre of
  mass, so dropping two wheels off doesn't yank the car round, and it fades at low speed so you can drive out.
  Grip eases between surfaces over ~0.1 s instead of switching instantly at the track edge.
  Off-track you get a grass rumble or gravel crunch and dust behind the wheels (visual only; the body stays steady).
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

For testing, `window.__game.simulate(seconds, true)` runs the physics headless with the autopilot.

## Not yet

Elevation (Albert Park is flat; Spa/COTA will need SRTM data), pit lane, ghosts, leaderboards, multiplayer.

Track data: [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) (LGPL-3.0).
