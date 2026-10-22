# Fast Roads

Browser time-trial racer on real circuit layouts. Prototype covering build steps 1–3:
one circuit (Albert Park, Melbourne), a downforce open-wheel car, and lap/sector timing with track limits.

## Run

Open `index.html` in a browser (Chrome/Firefox/Edge). It loads three.js and Rapier from the jsDelivr CDN,
so it needs an internet connection. To serve it locally instead:

    python3 -m http.server 8000   # then open http://localhost:8000

Append `?autopilot` to the URL to watch the built-in driver lap the circuit.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake (hold when stopped to reverse) |
| A D / ← → | Steer |
| R | Reset to track (invalidates the lap) |
| Enter | Restart session at the grid |
| C | Cycle camera (chase / far / onboard) |
| T | Traction control on/off |
| M / P / H | Mute / pause / hide help |
| O | Autopilot on/off |

Gamepad: RT throttle, LT brake, left stick steer, Y camera, X reset.

## How it works (all in `index.html`)

- **Track**: TUM centerline + widths (`tracks/melbourne.csv`, embedded in the page) → Catmull-Rom → resampled every ~2 m.
  Kerbs, gravel traps, and barrier offsets are derived from curvature; barriers are shrunk/dropped where they'd
  intrude on another part of the circuit. Road, kerbs, gravel, and walls are ribbon meshes built from the samples.
- **Physics**: Rapier rigid body (fixed 120 Hz step, interpolated rendering). Custom raycast suspension with
  anti-roll bars, simplified Pacejka lateral curve with load sensitivity, friction circle, downforce and drag ∝ v²,
  torque curve + 8-speed auto box, per-surface grip and drag. Walls are static cuboid colliders.
- **Timing**: start/finish + two sector lines as segments; crossings are detected per tick and interpolated within
  the tick. A lap is deleted if all four wheels pass the kerb (or white line where there's no kerb), on reset, or when
  crossing a line backwards. Best lap, best sectors, and the best-lap trace (for the live delta) persist in localStorage.

Measured car performance: 0–100 km/h 2.9 s, 0–200 km/h 5.5 s, top speed ~325 km/h, ~3.2 g average braking from top speed,
lateral grip 1.3 g at 60 km/h rising to 4.3 g at 260 km/h.

For testing, `window.__game.simulate(seconds, true)` runs the physics headless with the autopilot.

## Not yet

Elevation (Albert Park is flat; Spa/COTA will need SRTM data), pit lane, ghosts, leaderboards, multiplayer.

Track data: [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) (LGPL-3.0).
