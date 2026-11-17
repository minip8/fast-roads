# Fast Roads

Browser time-trial racer on real circuit layouts. Prototype covering build steps 1–3:
the 2026 Formula 1 calendar's circuits (all 22 raced, plus Bahrain and Jeddah, whose rounds were cancelled), three cars (a 2026 F1 car and a GT3 on LibreCorsa's physics engine, and a rear-drive drift car on the game's own physics), and lap/sector
timing with track limits.

## Run

Needs Node.js. Install once, then start the dev server and open the URL it prints:

    npm install
    npm run dev        # dev server with live reload
    npm test           # headless physics tests (lap times at Melbourne and Silverstone, handling, every circuit's data)
    npm run test:laps  # the pinned autopilot laps at every other circuit (a few minutes)
    npm run build      # type-check + static build in dist/ (host anywhere; `npm run preview` serves it locally)
    npm run build:env  # the reinforcement-learning environment worker, build/env/worker.mjs (docs/ai-env.md)
    npm run server     # the multiplayer relay, on ws://<this machine>:8787 (docs/net.md)
    npm run relay:cf   # the same relay as a Cloudflare Worker, run locally (ws://127.0.0.1:8787, no account)

The built game works from any sub-path of any static host, and keeps working offline after the first visit: a small
service worker (`src/sw.js`, production builds only) caches the build; the page itself is always fetched fresh when
online, so a new deploy shows up on the next load.

For development, append `?autopilot` to the URL to skip the menu and watch the built-in driver lap the circuit.
The autopilot isn't part of the game itself. It laps every circuit cleanly in every car except the drift car at
Spa, which slides wide in the fast sweepers there. `?opponents=2` (that many of your car) or `?opponents=lcgt3,drift`
(car ids: `lcf1`, `lcgt3`, `drift`) adds autopilot cars starting 30 m apart ahead of you, to drive into: a first step
towards multiplayer, with no race rules, HUD or minimap for them. A restart puts them back too.

## Main menu

The game opens on a menu with **Drive** at the top right and three tabs:

- **Race**: a card for each car (what it is, power, weight, your best lap at this circuit), **Multiplayer** (below),
  and a card for each circuit (its outline with the start/finish line, place, length, your best lap there in the
  chosen car). With seven or more circuits a search box filters them. Choosing another circuit reloads the game onto
  it (not while in a room: the room decides). **Reset best times** clears the chosen car's at this circuit, and its
  ghost (click twice to confirm).
- **Settings**, in five sections:
  - *Driving*: gears (automatic / manual), traction control, countersteer assist (drift car), ghost car (shown / hidden).
  - *Camera*: camera, field of view (−15° to +20° on every camera), widen the view with speed, camera shake on kerbs
    and off track, driver camera hands.
  - *HUD*: speed units (km/h / mph), timing panel (full / compact / hidden), live delta, track map (hidden / small /
    medium / large), tyre temperatures (shown / hidden), rear-view mirror (hidden / onboard & driver cameras / all cameras), mouse steering bar, key help (at start / always / hidden), frame rate counter, HUD size (70–150%)
    and panel background (0–100%).
  - *Graphics*: render resolution (50–100% of the screen's pixels), shadows (off / low / high), brightness.
  - *Audio*: sound on/off and volume.

  **Reset all settings** puts them all back (not the car or circuit).
- **Controls**: steering device (keyboard / mouse), mouse sensitivity and deadzone, gamepad stick deadzone; every
  keyboard action with two keys each, which you can change (click a key, press the new one; Backspace clears it, Esc
  cancels; a key moves from whatever action had it); **Reset keys to defaults**; and the mouse and gamepad controls.

Settings and keys are remembered in the browser. While driving, **Esc** (or **P**, or Start on a gamepad) opens it as a
pause menu, with **Resume** and **Restart lap** at the top. Mouse, keyboard (↑ ↓ move, ← → change, Enter select, Esc
resume) and gamepad (d-pad, A select, B / Start resume, LB / RB change tab) all work in the menu.

Cameras: **Onboard** (above the F1's airbox, on the other cars' bonnets), **Driver** (from the driver's eyes, with
the cockpit, steering wheel and the driver's arms; the wheel turns with the road wheels at each car's steering
ratio), **Chase** and **Far**. Every car carries a driver, visible from outside too. The driver's arms and gloves
are hidden in the Driver camera unless **Driver camera hands** is set to Shown (they always show from outside).
In the Driver camera the instruments are live: the F1's steering-wheel screen (speed, gear, live delta to your best
lap, battery charge, straight-mode flaps, TC) under 15 shift lights; the GT3's dash display (rpm bar, gear, speed,
lap time, delta, last lap, ABS and TC lights, pedals) under its 10 LEDs; the drift car's cluster (tachometer, gear,
speed, lap time, TC and ABS lights) with a shift light on top. The shift lights fill as the HUD's do and flash at
the upshift point.

**Looking behind.** Hold **B** (or click the right stick on a gamepad) to look back; let go and the view is
straight back to where it was. From the Onboard and Driver cameras you look back over the top of the car with its
tail at the bottom of the view; from Chase and Far the camera swings round to the same distance in front of the car,
looking back at it and the road behind. You keep driving while you look. The **rear-view mirror** at the top of
the screen shows the road behind all the time, mirrored left to right as a real mirror is: from the driver's eyes,
without your own car in the way. It is on in every camera by default; the HUD settings can limit it to the Onboard
and Driver cameras or hide it. It hides while you look back, in the menu, and on narrow screens (phones held upright).

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
  - **Tyres start warm, as on a lap** (carcass about 91 °C on the F1, 64 front / 67 rear on the GT3, the tread
    cooler, the pressures up to match: the autopilot's tyres passing the start spot after seven laps), not out of
    their blankets, and heat and cool as they work: the tread surface, the carcass, inner/middle/outer bands, and the
    inflation pressure with the carcass temperature. Grip follows the temperature (full grip with the carcass at
    70–85 °C on the GT3, 95–110 °C on the F1) and the pressure. At the autopilot's pace they stay a little short of
    that window (about 1–2% of grip lost, as in LibreCorsa itself); driven at the limit they reach it (the GT3 at
    Silverstone 72–78 °C, the F1 93–97 °C). The brake discs heat too, and their pads bite less when cold. A restart
    fits fresh tyres (at that start heat) and brakes, and gives the F1 a full battery. The
    tyres do not wear (nor grain, blister or flat-spot) and no fuel is burnt.
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

**Ghost car.** Your best lap at this circuit in this car is replayed by a translucent copy of the car, so you can
race yourself. It sets off from the line as your lap does and stays in step with it: it is level with you when the
live delta reads zero, and it crosses the line at your best lap time, where it disappears until your next lap starts.
It has no collision and casts no shadow, fades out when it is close to the camera (so in the Driver and Onboard
cameras it never blocks the view), and shows on the track map as a light blue dot. Only a valid lap that beats your
best becomes the ghost; it is saved with your best times, so it is there after a reload. Turn it off under Driving.

**Every lap is a flying lap.** You start before the last corner or corners of the lap, on the straight leading
to them (at Albert Park before turns 13 and 14, at Silverstone before Vale and Club, at Monza before the Parabolica,
at Monaco out of the Swimming Pool before La Rascasse), already at the speed the car has there on a lap and in the
gear for it. Drive those corners onto the start straight: the lap starts as you cross the line, at whatever speed
you carried through them. The run-up takes 8–20 s depending on the circuit and car (about 12 s in the GT3 at Albert
Park). **R** (or Enter, or Restart lap in the menu) puts you back there at any time and drops the lap you were on;
so does the game when the car ends up on its roof. The start speed is fixed per car and circuit (131 km/h for the
F1 2026 at Albert Park, accelerating out of turn 12; 216 km/h before Vale at Silverstone), so every attempt begins
the same way. Track limits count in the run-up too: put all four wheels off the road there (cutting the last
chicane, say) and the lap that follows is deleted, as is the one you were on if you were finishing a lap.

## Multiplayer

Hot laps together: everyone in a room drives the same circuit at once, each with the game's flying start and
restarts, and the room keeps a board of best laps. There are no grid starts or race rules yet.

Someone runs the relay (`npm run server`, a small Node WebSocket server on port 8787, or the same relay on
Cloudflare, below; it runs no physics). In the
menu's Race tab, **Multiplayer** takes a room code (1-8 letters or digits), your name and the relay's address
(by default the page's own host on port 8787, or `VITE_RELAY_URL` set when the game was built); **Join** enters the
room and **Leave** leaves it. The first player in a room sets its circuit; joining a room at another circuit
reloads the game there. A link with `?room=CODE` (and `&server=ws://host:port` for another relay) joins on load,
and the page's address shows it while you are in a room, so it can be shared.

- Your computer simulates only your car; everyone else's comes over the network, a little in the past, extrapolated
  to the present. Each player's car has a name tag over it and a coloured dot on the track map.
- Cars collide. Your game pushes your car off the others as it sees them and tells their game about the hit, so a
  hit is felt on both sides even when the two games disagree slightly about where the cars were.
- A car is a **ghost** (drawn translucent, collides with nothing) after a restart, while its driver is in the menu
  (the game sends it as paused) and when its connection has gone quiet, until it has been clear of every other car
  for a second. So several players restarting onto the same spot at once do not crash into each other. Yours shows
  GHOST in the HUD while it lasts.
- The board, under the timing panel: the room, the players (best lap first, the gap to the fastest, the car, and
  whether each is on track, a ghost, in the menu or has no signal), then short notices when someone joins, leaves or
  sets a best lap. Your own lap times, best laps and ghost car are kept in the browser as in single-player.

The Node relay speaks plain `ws://`; a page served over https needs a `wss://` address, so put it behind a TLS
reverse proxy, or host the relay on Cloudflare. Without a room joined the game is single-player as before, and does not download the networking code.

### Hosting it free on Cloudflare

The site on Cloudflare Pages and the relay as a Worker with one Durable Object per room, both on the Free plan
(exact steps, limits and the arithmetic: docs/net.md, **Going live**):

1. Relay: `npx wrangler login`, then `npm run relay:deploy`. It prints the Worker's address,
   `https://fast-roads-relay.<your-subdomain>.workers.dev`; the relay is `wss://fast-roads-relay.<your-subdomain>.workers.dev`.
2. Site: a Pages project from this repository with build command `npm run build`, output directory `dist`, and the
   environment variable `VITE_RELAY_URL` set to that `wss://` address (and `NODE_VERSION` 24).
3. Share `https://<project>.pages.dev/?room=CODE`.

The Free plan allows about 13.7 player-hours a day (each player's 40 car states a second are billed as 2 requests
a second against 100,000 a day); past that, joining fails until 00:00 UTC, and nothing is charged.

## HUD

Bottom right: F1-style shift lights (5 green, 5 red, 5 blue) fill towards the shift point and all flash there
(where the automatic box shifts up: 12,200 rpm in the F1 2026, 7,500 in the GT3, 7,200 in the drift car); throttle (green) and brake (red) bars show how hard each pedal is
applied; then the gear and speed. Left of it, in the F1 2026 and GT3 (the drift car's physics has no tyre heat):
the four tyres as on the car, each with its carcass temperature (°C, large), tread surface temperature (T), hot
pressure (psi) and brake disc temperature (B). The tile is coloured by the carcass against the compound's working
window: blue more than 10 °C short of it, light blue nearly there, green in it, orange up to 10 °C over, red beyond.
The strip across its top is the tread surface's outer, middle and inner bands (outer edge outside, as on the car),
coloured against the same window with 20 °C margins: the carcass moves slowly and sets the window, the tread heats
in a corner and cools on a straight within seconds (the grip reads a quarter of it). On a phone: the strip,
carcass temperatures and pressures only, bottom left. Top left: the lap time, live delta to your best lap, sectors (purple: your best ever, green: best
this session, yellow: slower), last / best / optimal laps and the laps driven. Under it, in a multiplayer room: the room's board and notices. Top right: the track map. Top centre: the rear-view mirror. Bottom left
for the first seconds of driving: the keys, as currently bound (then a small reminder of the help and menu keys).
What shows, and how big, is set in the menu's HUD settings.

## Controls

The default keys (all but Esc can be changed in the menu's Controls tab):

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake (automatic gears: hold when stopped to reverse, up to ~40 km/h; W then brakes, and selects first once stopped) |
| A D / ← → | Steer |
| R / Enter | Restart the lap: back before the last corners at flying-lap speed |
| V | Mouse steering on/off (also in the menu) |
| C | Cycle camera (onboard / driver / chase / far) |
| B | Look behind (hold) |
| G | Automatic / manual gears (also in the menu) |
| E / Q | Shift up / down (manual): reverse, neutral, first... A downshift that would over-rev is refused, and reverse is selected only at a standstill. In R the throttle drives backwards and the brake brakes |
| T | Traction control on/off |
| Esc / P | Open the menu (pauses) |
| M / H | Mute / show or hide the key help |

Gamepad: RT throttle, LT brake, left stick steer, RB/LB shift up/down, Y camera, right stick click (hold) look behind,
X or Back restart, Start menu.

Mouse steering: the cursor stays visible, and how far it is left or right of the screen centre sets the wheel
(in direct proportion, reaching full lock towards the edge). Mouse sensitivity (Low / Medium / High) in the menu sets how far
you need to go, and Mouse deadzone (Off / Small / Medium / Large) sets how wide the do-nothing zone around the
centre is. Left click is throttle, right click is brake, scroll shifts gears in manual. Steering keys still work
and override the mouse while held.

## How it works (TypeScript in `src/`, one module per area)

- **Circuits**: the 2026 calendar, in round order: Albert Park, Shanghai, Suzuka, Miami, Montreal, Monaco,
  Barcelona-Catalunya, the Red Bull Ring, Silverstone (Grand Prix layout, starting on the Hamilton Straight), Spa,
  the Hungaroring, Zandvoort, Monza, the Madring, Baku, Marina Bay, COTA, Mexico City, Interlagos, Las Vegas, Lusail
  and Yas Marina, then Bahrain and Jeddah (on the calendar as published, cancelled in March 2026). Each is a
  centreline + widths CSV in `tracks/` (first row on the start/finish line, rows in the racing direction), loaded
  only for the circuit being driven; `src/tracks.ts` lists them with their grid spot, scenery and display data
  (country, official lap length, round). Thirteen come from the TUM racetrack database as they are. The other eleven
  (Miami, Monaco, Barcelona, Zandvoort, Madrid, Baku, Singapore, Las Vegas, Lusail, Yas Marina, Jeddah; the TUM files
  of Barcelona, Zandvoort and Yas Marina are older layouts) are lon/lat centrelines from bacinger/f1-circuits that
  `scripts/tracks/convert.mjs` projects to metres, turns to the racing direction, starts at the line, resamples
  every 5 m and gives constant widths (the source has none: narrower at street circuits, the TUM file's mean where
  it has an older layout); where two parts of a lap run side by side closer than the roads really are (Baku's
  dual carriageway, Monaco's Loews hairpin), it moves them apart so a wall fits between. Each lap is within about 1%
  of the official length. The game is flat: Suzuka's crossover is a level crossing, with the walls of each road
  left open where the other passes through.
  Each CSV → Catmull-Rom → resampled every ~2 m.
  Kerbs, gravel traps, and barrier offsets are derived from curvature (the street circuits, Monaco, Baku, Singapore,
  Las Vegas and Jeddah, have no gravel and walls 3.5 m from the edge); barriers are shrunk/dropped where they'd
  intrude on another part of the circuit, and grandstands and the pit building are left out or shortened where
  they would. Road, kerbs, gravel, and walls are ribbon meshes built from the samples.
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
- **Car-to-car contact** (`src/collide.ts`): each car is a box in the ground plane (the drift car's hull and wheels,
  the LibreCorsa cars' barrier outline: the F1 reaches 3.2 m ahead of its centre of mass and 2.1 m behind), and
  LibreCorsa's own solver (`resolveCarToCarObbCollision`: separating axes, one impulse at the contact point with
  restitution 0.22 and friction 0.28) gives each car a change of position, velocity and yaw rate, which it applies to
  its own body on either engine. Contacts are resolved once a tick after every car has moved; overlap is undone at
  most 5 cm per car per tick, so cars placed on top of each other slide apart over about 0.2 s.
- **Multiplayer** (`src/net/`, `server/`, `src/multiplayer.ts`; `docs/net.md` has the protocol and the rules): each
  client sends its own car's state 40 times a second through the relay, which passes it on; the others are proxies
  (`RemoteCar`: extrapolated to the present along the turn they are on, corrections blended out over 50 ms) that
  the car is pushed off by the same contact solver. Each side applies its own half of a hit when its own simulation
  sees it, and from the other side's contact message when it did not (within about a round trip), never both. In
  the headless tests (40 ms each way, 2% loss) a proxy at 300 km/h is within 0.06 m of the real car on average and
  0.26 m at worst.
- **Car bodies**: built from boxes and extrusions in code (`src/carMeshes.ts`), each with a seated driver whose
  hands turn the steering wheel in the driver camera. The instruments (`src/cockpitDisplay.ts`) are drawn on a
  small canvas per car, redrawn only in the Driver camera, when a shown value changes, at most 30 times a second. The GT3 instead shows a 3D model (`public/cars/lcgt3/`, about
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
  0.1 s to make, one per frame, the first time a GT3 is driven. Tyres squeal at the limit of grip on asphalt and kerbs (cornering, braking or wheelspin): silent
  with grip in hand, a faint scrub as the tyres near their peak slip, the squeal from 90% of it, full a little past
  it, which is the cue to catch a slide (the F1 squeals under hard braking: its ABS runs the fronts past their peak); kerbs rumble at the strip rate, road and wind noise rise with speed, and hard impacts
  thud. Sound starts on the first click or key press (browser autoplay rules), fades out while paused, and stops
  while muted or in a background tab.
- **Menu and HUD**: plain DOM and CSS, no framework. The menu (`src/menu.ts`) is built from the settings table
  (`src/settings.ts`), the cars and the circuit list, so a new setting, car or circuit appears in it by itself; the
  circuit outlines are drawn from the same centreline data as the track. Key bindings live in `src/keys.ts`.
- **Rear-view mirror** (`src/mirror.ts`): after the main view, the scene is drawn again into the mirror's rectangle
  of the screen (viewport and scissor, no extra render target) from the driver's eyes looking back, with the car's
  own body hidden. The image is flipped by mirroring the whole scene for that pass and turning the camera to match,
  so three.js reverses the faces' winding itself and everything renders as usual. The shadow map isn't redrawn
  (its matrix is mirrored for the pass) and the far plane is 1.2 km. It costs about 28 draw calls and 180k
  triangles a frame on top of the main view's 70–80 calls and 300k triangles; with the mirror off nothing of it runs.
- **Timing**: start/finish + two sector lines as segments; crossings are detected per tick and interpolated within
  the tick. A lap is deleted if all four wheels pass the kerb (or white line where there's no kerb) or when
  crossing a line backwards; the same off-track in the run-up to the line (the stretch from the start spot, at the
  end of every lap) deletes the next lap as well. A restart drops the lap under way and forgives the run-up. Best lap, best sectors, and the best-lap trace (for the live delta) persist in localStorage.
- **Ghost**: every lap is recorded at 10 Hz (position, heading, pitch, roll, steering) as it is driven; a new best
  lap's recording is packed (1 cm deltas and small angle steps, 11 bytes a sample: about 13 kB, 17 k characters of
  base64, for a two-minute lap) and saved next to the best times, which are saved first so a full storage only loses
  the ghost. Playback interpolates the samples smoothly (cubic for position) at the frame rate.
- **RL environment** (`src/ai/`, `ai/`): for training a driver by reinforcement learning, in the game's own
  headless simulation. Reset/step over the same session the game and tests run (20 actions a second by default:
  steering as a share of the car's lock and one throttle/brake axis, automatic gears), a track-relative observation
  vector built by a pure function the browser can reuse, a reward for centreline progress that pays nothing for
  cutting, penalties for walls and leaving the track, random starts anywhere on the lap, and an evaluation mode that
  times one flying lap with the game's own timing. `npm run build:env` bundles a worker process that runs a batch of
  environments for a trainer over a binary stdin/stdout protocol; `docs/ai-env.md` documents all of it. Not part of
  the game's bundle.
- **Brake markers**: 300/200/100 m boards before every braking zone where the speed drops by more than ~50 km/h,
  counting down to the turn-in point. Zones are found from the autopilot's speed plan; boards are skipped when they'd
  fall inside the previous corner.

Tests (`npm test`, and `npm run test:laps` for the circuits beyond the first two) run the same physics headless in Node and check autopilot lap times to the millisecond, so any
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

Elevation (every circuit is flat: Spa, COTA, Interlagos and the Red Bull Ring will need SRTM data, and Suzuka's crossover a bridge), pit lane, online leaderboards, multiplayer races (grid starts, race rules).

Track data: [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) (LGPL-3.0): Melbourne,
Shanghai, Suzuka, Montreal, Spielberg, Silverstone, Spa, Budapest, Monza, Austin, Mexico City, São Paulo and Sakhir,
and the widths at Barcelona, Zandvoort and Yas Marina. [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits)
(MIT): the centrelines of Miami, Monaco, Barcelona, Zandvoort, Madrid, Baku, Singapore, Las Vegas, Lusail, Yas Marina
and Jeddah, converted by `scripts/tracks/convert.mjs` (each CSV's header names its source file), under this licence:

> Copyright (c) 2019-2025 Tomislav Bacinger
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

Circuit names are used to say which real circuit a layout follows; the game is not affiliated with Formula 1 or the
circuits.
The physics engine and the F1 2026 and GT3 car data:
[KhazP/librecorsa](https://github.com/KhazP/librecorsa) (MIT; see `src/lc/vendor/README.md`).
