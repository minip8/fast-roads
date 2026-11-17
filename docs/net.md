# Multiplayer networking

The networking layer for multiplayer: `src/net/` (browser-safe, shared by the game and the relay) and `server/`
(the relay: on Node, `server/ws.ts`, and on Cloudflare Workers, `server/cf/`, both running the same `Relay`). The game uses it through `src/multiplayer.ts` (**In the game**, below). The source of truth for
the byte layout is `src/net/protocol.ts`: keep the two in step.

## Model

Owner-authoritative state replication.

- Each client simulates only its own car and sends its state 30-60 times a second (default 40) on the unreliable
  lane. Every other car is a proxy: a `RemoteCar` buffer extrapolates it to the present from the states received
  and blends corrections out. Each client collides its own car against the proxies itself, and tells the other
  car's client about the hit (`contact`) so that side can apply its half if its own simulation missed it.
- The relay (`server/`) is thin: rooms, the roster, the room's circuit, a shared clock (ping/pong) and the
  session's lap board. It runs no physics. It forwards car states as the bytes the client sent, with the player
  byte overwritten by the sender's id, so a claimed id is never trusted.
- The first mode is a shared hot-lap session: everyone on track together, flying starts as the game has now, best
  laps on a board. Grid starts and race rules are not in yet; message types 0x20-0x2f are reserved for them, and
  the protocol is versioned.
- Transport: an interface with a reliable (ordered) lane and an unreliable lane. Code above the transport never
  assumes the unreliable lane orders or delivers anything, even though the WebSocket transport (both lanes on one
  socket) happens to. WebRTC data channels are planned as a third transport.

All times in the API are seconds. `now` is the game's local monotonic clock (`performance.now() / 1000`); relay
times are seconds since the relay process started, which every client estimates with `serverTime(now)`.

## Files

| File | What |
|---|---|
| `src/net/protocol.ts` | wire format: encoders, `decodeMessage` (never throws), quantisation, limits, ids of messages and errors |
| `src/net/transport.ts` | `Transport` interface (`send(lane, data)`, `close`, `onOpen` / `onMessage` / `onClose`) |
| `src/net/websocket.ts` | `WebSocketTransport(url)`: the client side over the browser's (or Node's global) `WebSocket` |
| `src/net/loopback.ts` | `LoopbackNet`: in-process emulated network for tests (latency, jitter, loss, duplication, reordering; seeded, manual clock) |
| `src/net/clock.ts` | `ClockSync`: relay clock estimate from ping/pong |
| `src/net/remote.ts` | `RemoteCar`: a proxy's state buffer (pure maths) |
| `src/net/client.ts` | `NetClient`: the game's side of a session |
| `src/net/ids.ts` | the car and circuit ids the relay accepts (`NET_CARS`, `NET_CIRCUITS`; the compiler and a test check they match `CARS` / `TRACKS`) |
| `src/net/index.ts` | what the game imports |
| `server/relay.ts` | `Relay`: rooms and limits, transport-agnostic; `plausibleLap`, `sanitiseName` |
| `server/env.ts` | `relayEnv`: `MAX_PLAYERS`, `BATCH_MS`, `MIN_LAP_SECS` from either server's environment |
| `server/ws.ts` | `listen({ port })`: the relay on a `ws` WebSocket server |
| `server/main.ts` | `npm run server` entry point |
| `server/cf/worker.ts` | the relay on Cloudflare: the Worker (routing) and `RelayRoom`, the Durable Object of one room |
| `server/cf/wrangler.jsonc` | its wrangler config (`server/cf/tsconfig.json`: type-checked with the Workers types) |

`ws` is used only by `server/`; a test checks nothing in `src/` imports it, `wrangler`, `cloudflare:*`, `node:*` or
`server/`. `src/net/ids.ts` imports nothing (the compile-time check against the game's ids is `idsCheck.ts`, which
nothing imports), so the Worker's typecheck sees none of the game's DOM code.

## Wire format

Connection address: the relay's URL with `/room/CODE` appended to its path (`relayUrl(server, room)` in
`src/net/websocket.ts`: `wss://relay.example` -> `wss://relay.example/room/ABCD`; a query is kept), so a server
can route the connection to its room before the hello (the Cloudflare relay has to). `roomFromPath` reads it back:
a path ending in `/room/CODE` ties the connection to that room, and a hello for another room is refused (`badRoom`,
fatal); `/room/` followed by anything but a room code is refused at the handshake with HTTP 400. The Node relay also
takes a path without `/room/` (the hello's room decides); the Cloudflare one answers those with 404 (`/` with a
line of text).

Every message is one transport frame starting with a `u8` type. Little-endian. `str` is a `u8` byte count then
that many bytes of UTF-8 (rejected if not valid UTF-8). Times marked `time32` are the relay clock in units of
1e-4 s, mod 2^32 (wraps every 4.97 days; receivers unwrap next to their own estimate of the relay clock:
`unwrapTime(wire, refS)`). Lap and sector times are `u32` microseconds, `0xFFFFFFFF` = not timed.

Ids: room codes are 1-8 of `A-Z0-9`; car and circuit ids 1-16 of `a-z0-9`; player ids 1-255 (0 = "set by the
relay" in client messages, and "left" on the board).

Messages that a client sends and the relay forwards (`state`, `contact`, `lap`, `restart`) carry the player byte
at offset 1: the client writes 0 and the relay overwrites it with the sender's id before forwarding the same bytes.

### Unreliable lane

`state` 0x01, both ways, 42 bytes (`STATE_BYTES`):

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | type 0x01 |
| 1 | u8 | player (0 from a client; the sender's id from the relay) |
| 2 | u16 | seq: +1 per state sent, wraps; newer = `seqNewer(a, b)` (serial arithmetic) |
| 4 | u32 | time32: the sender's estimate of the relay clock for this state |
| 8, 11, 14 | i24 x3 | position x, y, z, mm (range +-8388.607 m) |
| 17, 19, 21 | u16 x3 | rotation, smallest three: the quaternion's components other than its largest, each as 15 bits over [-1/sqrt2, 1/sqrt2] (value = (k - 16383) / 16383 / sqrt2, k <= 32766); the largest is rebuilt (made positive); its index (0-3 = x y z w) is bit 15 of the first u16 (low bit) and of the second (high bit); bit 15 of the third is 0 |
| 23, 25, 27 | i16 x3 | linear velocity, 0.01 m/s (+-327.67 m/s), world axes |
| 29, 31, 33 | i16 x3 | angular velocity, 0.001 rad/s (+-32.767 rad/s), world axes |
| 35 | i8 | steer: front wheel angle, 0.01 rad (+-1.27), + = left |
| 36, 37 | u8 x2 | throttle, brake as applied, /255 |
| 38 | i8 | gear: -1 reverse, 0 neutral, 1-15 |
| 39 | u16 | rpm, 0-30000 |
| 41 | u8 | bits 0-3 flags: 1 `noCollide`, 2 `paused`, 4 `flapsOpen`, 8 reserved (must be 0); bits 4-7 restart epoch (0-15) |

Quantisation (half a step): position 0.5 mm, velocity 5 mm/s, angular velocity 0.5 mrad/s, rotation under 0.01
degrees (tested over 2000 random orientations), steer 0.005 rad. `encodeState` clamps out-of-range values and
writes non-finite ones as 0 (rotation as identity), so a broken local state never makes an undecodable packet.

The epoch goes up by one (mod 16) at every restart or teleport: receivers do not blend across a change, and
since every state carries it, a lost packet cannot hide a restart.

`states` 0x02, relay to client only (batching, off by default): `u8 type | u8 n (1-32) | n x 42-byte state`
(whole state messages, player bytes set). Decoded as `{ type: 'states', states }`; `NetClient` handles it as n
states.

### Reliable lane

`player` record: `u8 id | str name (<= 48 bytes) | str car`.
`board` body: `u8 n (<= 32) | n x { u8 player (0 = has left) | str name | str car | u32 best | u32 s1 | u32 s2 | u32 s3 | u16 laps }`, sorted by best.

| Type | Name | Direction | Body after the type byte |
|---|---|---|---|
| 0x10 | hello | C->R | `u16 version | str room | str name (<= 48 bytes) | str car | str circuit (may be empty: the relay's default; used only if this hello creates the room)` |
| 0x11 | welcome | R->C | `u16 version | u8 you | str room | str circuit | f64 serverTime (s) | u8 maxPlayers | u8 stateHz (the most states a second the relay takes; >= 1) | u8 n (<= 32) | n x player (everyone, you included) | board body` |
| 0x12 | joined | R->C | `player` |
| 0x13 | left | R->C | `u8 id | u8 reason` (0 left, 1 timeout, 2 kicked) |
| 0x14 | player | both | `player`. C->R: id 0, my new name and/or car; R->all (sender included): the player's name and car now |
| 0x15 | ping | C->R | `u32 nonce | f64 clientTime` |
| 0x16 | pong | R->C | `u32 nonce | f64 clientTime (echoed) | f64 serverTime` |
| 0x17 | contact | C->R->C | `u8 from (0 from the client) | u8 to | time32 | f32 ix, iy, iz | f32 px, py, pz | f32 closing` (35 bytes) |
| 0x18 | lap | C->R->all | `u8 player (0 from the client) | u32 time | u32 s1, s2, s3 | u8 valid (0/1)` (19 bytes) |
| 0x19 | board | R->all | board body |
| 0x1a | restart | C->R->others | `u8 player (0 from the client)` |
| 0x1f | error | R->C | `u8 code | u8 fatal (0/1) | str message (<= 200 bytes)` |

`contact`: `i` is the impulse the sender's car received (N s, world axes); the other car takes the opposite. `p`
is the contact point (world, m, each axis within +-1e5), `closing` the closing speed along the contact normal
(0-200 m/s). |i| at most 1e6.

`hello` and `welcome` keep `u16 version` at offset 1 in every protocol version (`helloVersion(data)` reads it
without decoding the rest), so a relay can refuse a client of another version with a proper error.

Error codes (`ERROR`): 1 version, 2 roomFull, 3 badName, 4 badCar, 5 badCircuit, 6 badRoom (a hello for another room than the address names; a bad room code in a hello fails decoding, so it is `malformed`), 7 malformed, 8 rate,
9 tooBig, 10 idle, 11 notJoined, 12 lapRejected, 13 badContact, 14 serverFull, 15 shutdown. A fatal error is
followed by the relay closing the connection.

### Decoding

`decodeMessage(data)` returns `{ ok: true, msg }` or `{ ok: false, error }` and never throws. It rejects: an
empty frame, an unknown or reserved type, truncation, trailing bytes, invalid UTF-8, strings over their field's
limit, room codes and ids outside their alphabets, non-finite floats, a hello or welcome of another version, a
quaternion whose three components square-sum over 1, gear outside -1..15, rpm over 30000, the reserved flag bit,
a `left` reason over 2, error/lap flags other than 0/1, a lap without a time or over 3600 s, a board or roster
over 32, a bundle of 0 or over 32 states or with any bad state, a contact out of range. `stateValid(data)` is the
relay's allocation-free check of a client's state (same checks). Fuzzing (`test/net-protocol.test.ts`): 10000
random frames, every truncation of every message, 1500 random mutations of each: nothing throws, and anything that
decodes encodes again to the same message.

## Client API (`NetClient`)

```ts
import { NetClient, WebSocketTransport, emptyCarState, emptySample, STATE_FLAG } from './net';

const net = new NetClient(new WebSocketTransport('wss://relay.example/'), {
  room: 'ABCD',                // 1-8 of A-Z 0-9 (lower case is upper-cased)
  name: 'Max',                 // first 16 characters; the relay sanitises it
  car: 'lcf1',
  circuit: 'monza',            // wanted if this creates the room; the welcome says the room's circuit
  sendHz: 40,                  // default 40; capped by the welcome's stateHz (60)
  clock: () => performance.now() / 1000,   // stamps arrivals as they happen (recommended)
});
```

Constructor options: `room`, `name`, `car`, `circuit?`, `sendHz?`, `clock?`, `timeout?` (s without hearing the
relay before giving up, default 15), `remote?` (`RemoteOptions` for every proxy). Throws on an invalid room code,
car or circuit id.

| Member | |
|---|---|
| `update(now)` | every frame: handles what arrived, sends hello once the transport is open, pings (every 0.5 s for the first 6, then every 2 s), closes on `timeout` |
| `sendState(state: CarState, at)` | our car's state as of local time `at`; sent only once joined and when due by `at` (`sendHz`); returns whether it went. Call every tick or every frame |
| `sample(id, now, out, smooth = true)` | player `id`'s car at local time `now`, into `out` (a `RemoteSample` from `emptySample()`); null if no such player or nothing received yet |
| `takeEvents(): NetEvent[]` | what happened since the last call, in order |
| `sendContact({ other, at, impulse, point, closing })` | we hit player `other`'s proxy at local time `at`; `impulse` is what OUR car received |
| `sendLap({ time, sectors, valid })` | a lap finished (every lap, valid or not) |
| `sendRestart()` | we were put back at the start spot (bump `state.epoch` as well) |
| `setPlayer({ name?, car? })` | a new car or name; the relay answers with a `player` event |
| `close(reason?)` | leave |
| `status` | `'connecting'` (transport not open) / `'joining'` (hello sent) / `'joined'` / `'closed'` (`closeReason`) |
| `selfId`, `room`, `circuit`, `maxPlayers`, `sendHz` | from the welcome |
| `players: Map<id, PlayerInfo>` | everyone in the room, ourselves included |
| `remotes: Map<id, RemoteCar>` | everyone else's proxy |
| `board: BoardEntry[]` | the lap board (`{ player, name, car, best, sectors, laps }`, best first) |
| `serverTime(now)`, `rtt`, `jitter`, `clock` | relay clock and link quality (s) |
| `stats` | messages and bytes each way, states sent and received, `malformed`, `unknownSender` |

`CarState` (`emptyCarState()`): `x y z` (m), `qx qy qz qw`, `vx vy vz` (m/s), `wx wy wz` (rad/s, world axes),
`steer` (front wheel angle, rad, + = left), `throttle`, `brake` (0..1, as applied), `gear`, `rpm`, `flags`
(`STATE_FLAG.noCollide | paused | flapsOpen`), `epoch` (0-15). These map onto `Vehicle` as `pos`, `quat`, `vel`,
`angv`, `steer`, `throttle`, `brake`, `gear`, `rpm`, `flapsOpen`.

`RemoteSample` is a `CarState` plus `time` (relay time asked for), `age` (s past the newest state; negative when
sampling in the past), `extrapolated` (s actually extrapolated), `collidable`, `alpha` (1..0 as the proxy goes
stale, for drawing) and `correction` (m of correction still being blended out).

Events (`NetEvent`):

| `type` | Fields |
|---|---|
| `welcome` | `you, room, circuit, players` (followed by a `board` event) |
| `join` | `player` |
| `leave` | `player, reason: 'left' \| 'timeout' \| 'kicked'` |
| `player` | `player, before`: a name or car change (also our own, echoed) |
| `contact` | `from, time` (relay time), `impulse` (to apply to OUR car: already turned round), `point`, `closing` |
| `lap` | `player, time, sectors, valid`: accepted laps only, ours included |
| `board` | `board` |
| `restart` | `player` |
| `error` | `code, fatal, message` |
| `closed` | `reason` |

### Example: the game loop

```ts
const state = emptyCarState(), remote = emptySample();
let epoch = 0;

function frame(nowMs: number) {
  const now = nowMs / 1000;
  net.update(now);
  for (const e of net.takeEvents()) {
    switch (e.type) {
      case 'welcome': if (e.circuit !== settings.track) { /* load that circuit first */ } break;
      case 'join': case 'leave': case 'player': rebuildProxies(); break;   // a body per player, e.player.car
      case 'contact': applyImpulseIfMissed(e.impulse, e.point, e.time); break;
      case 'board': hud.showBoard(e.board); break;
      case 'error': if (e.fatal) showMessage(e.message); break;
      case 'closed': backToMenu(e.reason); break;
    }
  }

  // physics: fixed 120 Hz ticks; the proxies sampled at each tick's time, so collisions see where they are then
  while (accumulator >= DT) {
    const tickAt = now - (accumulator - DT);           // local time this tick's state is for
    for (const [id, car] of net.remotes) {
      const s = car.sample(net.serverTime(tickAt), remote);
      if (s?.collidable) placeCollider(id, s);           // kinematic body at s.x.., moving at s.vx.., spinning at s.wx..
      else removeCollider(id);
    }
    session.tick(input);
    // a hit our simulation resolved against proxy `id`:
    //   net.sendContact({ other: id, at: tickAt, impulse: whatOurCarGot, point, closing });
    copyCarState(session.car, state);                    // pos, quat, vel, angv, steer, pedals, gear, rpm
    state.epoch = epoch; state.flags = paused ? STATE_FLAG.noCollide | STATE_FLAG.paused : 0;
    net.sendState(state, tickAt);                        // goes out at sendHz
    accumulator -= DT;
  }

  // drawing: every proxy at the present
  for (const [id] of net.remotes) {
    const s = net.sample(id, now, remote);
    if (s) drawProxy(id, s);                             // fade with s.alpha
  }
}

// on restart:  epoch = (epoch + 1) & 15; net.sendRestart();
// on a lap:    net.sendLap({ time: lap.time, sectors: lap.sectors, valid: lap.valid });
```

Contacts: when the other car's client resolves a hit, ours receives a `contact` event about a one-way trip later.
NetClient applies nothing; the game's rule is under **In the game** below.

## In the game (`src/multiplayer.ts`)

`Multiplayer(net, session)` joins one game `Session` to a room. It has no DOM and no rendering, so
`test/multiplayer.test.ts` runs exactly this code with several Sessions in Node; the game adds `remoteCars.ts`
(the other cars drawn, name tags, minimap dots) and `netHud.ts` (the board), all loaded with `netGame.ts` by a
dynamic import, so a single-player page never downloads `src/net`.

| Member | |
|---|---|
| `update(now, paused)` | every frame, before the ticks: `net.update`, the events handled (roster, cars, contacts, laps), and returned for the game's own use (the circuit, errors, `closed`). `paused`: the game is not simulating (menu, before the first Drive) |
| `tick(input, autopilot, tickAt)` | in place of `session.tick`: proxies sampled at `tickAt` into `session.proxies`, the tick, then contacts, laps and our state sent. `tickAt` is the local time the tick's result is for (`now - (acc - DT)` in the frame loop) |
| `idle(now)` | a frame without ticks: our state, held, sent as paused |
| `players` | everyone else: `RemotePlayer` (info, spec, the proxy `body` and its `sample` at the last tick, `collidable`) |
| `noCollide`, `epoch`, `stats` | ours; `stats` counts contact ticks, events sent, applied, ignored, dropped, laps sent |
| `sampleAt(id, now, out)` | for drawing; the game draws other cars at `now - DT`, where the player's own car is drawn (interpolated a tick behind) |
| `takeNotices()` | joins, leaves, car changes, best laps, non-fatal errors, as text for the HUD |

Our car: the state after every tick (velocity and pedals zeroed while paused, so nobody extrapolates a parked car
down the road), the epoch bumped and `restart` sent whenever the Session puts the car at the start spot
(`Session.resets`: the player's restart, a stuck or flipped car, a car switch), a car switch told with `setPlayer`,
and every lap the timing completes (`Timing.lastLap`) sent, except one started before we joined (the relay would
refuse it).

Proxies: each player's `RemoteCar` sampled at the tick's time becomes a `ContactBody` (heading from the
quaternion's +z, yaw rate `wy`) with the shape of that player's car (`shapeOf`: a car of that spec built once and
destroyed). It is in `session.proxies` only while it is collidable: `sample.collidable` (fresh, owner has not set
`noCollide`), not `paused`, not suppressed (below), and our car is collidable itself.

Not collidable (`noCollide`), ours: from joining, after every restart, and while paused, until our box grown by
`CLEAR_MARGIN` (0.5 m) has overlapped no other car heard from in the last `collideAge`, collidable or not, for
`CLEAR_SECS` (1 s). A car that is itself not collidable counts in that test only if its player id is lower than
ours: of cars that stay on top of each other (the same car and line after restarting together) the lowest id is
collidable again first and the others wait for it, where each would otherwise wait for the other for ever. So
several players restarting onto the same spot at once are ghosts to each other until they have spread out, and a
player back from the menu cannot land on someone. While ours is not collidable we collide
with nothing and drop contact events.

Contacts, the rule:

1. Each client resolves its own car against the proxies (`Session.resolveContacts`) and applies its own half at
   once. It sums the impulse its car received over each `CHUNK_SECS` (0.1 s) of contact with one car and sends that
   as one `contact` event (time: the chunk's first tick), so a long lean costs 10 messages a second, not 120.
2. A received event is applied only if our simulation had no contact with that car from `W` before the event's
   time to the moment it arrived, where `W = clamp(0.08 + rtt + 2 jitter, 0.12, 0.5)` s. Otherwise our simulation
   already gave us our half, and the event is ignored.
3. Having applied one, we do not collide with that car's proxy until `W` after the event's time, so our own late
   detection of the same hit cannot add a second half. A sustained contact our simulation missed is carried on by
   the events.
4. Applying: the impulse (the opposite of what the sender's car received; the solver already split it by the two
   masses) becomes a velocity change `I / m` and a yaw-rate change from its lever arm, taken in our car's frame at
   the event's time (our pose is kept for 128 ticks) and turned to our heading now; no positional push. Capped at 20
   m/s and 3 rad/s. Events older than 1 s on arrival are dropped.

So every hit is applied once on each side: by both simulations when both see it (the usual case), and from the
event on the side that missed it. A hit both sides see at different moments more than `W` apart counts twice; one
seen by neither (both proxies wrong the same way) is lost.

Measured (`test/multiplayer.test.ts`, `NET_REPORT=1`; 40 ms + 0-10 ms each way, 2% loss, the relay in-process):
the proxy at the tick's time against the other client's real car, the F1 and GT3 on autopilot at Melbourne up to
300 km/h for 10 s: mean 0.06 m, p95 0.17 m, max 0.26 m. A GT3 at full throttle into a GT3 at rest: both simulations
saw the hit (8 ticks each), every event was ignored, and the momentum the two cars gained were 28.7 and 29.2 kN s
(sum 0.5 kN s, 2%). The same with the struck car's simulation blind to proxies: all 8 events applied, once each,
30.3 and 31.1 kN s (sum 0.8 kN s).

## Remote cars (`RemoteCar`)

`push(state, now)` with the state's time unwrapped onto the relay clock and `now` the receiver's relay time;
`sample(t, out, smooth)`. NetClient does both. Behaviour:

- Past the newest state: constant turn rate and velocity (the velocity turns with the angular velocity, so a car on
  a curve stays on it), the speed changing at the acceleration seen between the last two states (along the
  velocity only, capped at 60 m/s^2, never through zero), the body turning at its angular velocity; at most
  `maxExtrapolate` (0.35 s), then it holds.
- Between buffered states (8 kept): cubic Hermite positions from positions and velocities, normalised-lerp
  rotation, linear for the rest; before the oldest, the oldest.
- Dropped: states not newer than the newest by sequence (duplicates, reordering, late), and states stamped more
  than 2 s ahead of `now`. A state older in time than the newest but newer in sequence (the sender's clock
  snapped back) restarts the buffer.
- Corrections: on each new state the difference between what was being shown and the new prediction (position and
  rotation) decays exponentially with `blendTau` 0.05 s. More than `snapDistance` 4 m, or a new epoch, snaps.
- Staleness: `collidable` while `age <= collideAge` (0.4 s) and the owner has not set `noCollide`; `alpha` fades
  from 1 at 0.5 s to 0 at 1.5 s.

The cap is 0.35 s rather than 0.25 s because at 200 ms latency with jitter a 0.25 s cap held the car often
(p95 error 1.6 m, jumps of 4.5 m, below).

### Measured accuracy

`test/net-remote.test.ts` (`NET_REPORT=1` prints it): a car on a made-up lap at 50-90 m/s (full throttle, 4 g
braking, a 3 g hairpin, a sweeper, a chicane; inputs eased in over 0.15 s), states at 40 Hz through the emulated
link (encoded, so quantised; 5% loss, 1% duplicates, the jitter reorders), sampled at the present 120 times a
second, perfect clocks. Position error against the true car:

| Link (one way) | mean | p95 | max | yaw p95 | biggest frame-to-frame jump |
|---|---|---|---|---|---|
| 50 ms + 0-20 ms | 0.016 m | 0.029 m | 0.070 m | 0.37 deg | 0.060 m |
| 100 ms + 0-30 ms | 0.022 m | 0.069 m | 0.173 m | 0.87 deg | 0.064 m |
| 200 ms + 0-50 ms | 0.060 m | 0.298 m | 0.709 m | 2.24 deg | 0.086 m |
| 200 ms, constant-speed extrapolation | 0.227 m | 0.814 m | 1.714 m | 2.24 deg | 0.119 m |
| 200 ms, no smoothing | 0.040 m | 0.185 m | 0.625 m | 1.62 deg | 0.309 m |
| 200 ms, 0.25 s cap | 0.613 m | 1.571 m | 4.524 m | 2.25 deg | 4.501 m |

The proxy was collidable 100% of the time in all of them. These are best cases: the test car's inputs change
smoothly, a real driver's (and a car on kerbs) do not, and clock error adds on top: each millisecond of disagreement
between two clients' clocks is 9 cm at 90 m/s. Clock sync (`test/net-clock.test.ts`) on symmetric links with 10-40
ms of jitter stays within half the jitter plus 2 ms; an asymmetric link biases it by half the difference (30 ms up,
70 ms down: 20 ms), which no ping can detect. In the end-to-end test (40 ms + 0-15 ms, 3% loss, real clock sync on
both clients) proxies on a 300 m circle at 60 m/s were within 0.4-0.6 m.

## Clock sync (`ClockSync`)

NTP-style: each pong gives `rtt = t3 - t0` and offset `serverTime - (t0 + t3) / 2`. The offset estimate is the
sample with the lowest RTT among the last 16 (ties within 0.1 ms: the newest); `rtt` and `jitter` are smoothed as
TCP's srtt / rttvar (gains 1/8, 1/4). The offset in use moves towards the estimate at no more than 5% of elapsed
time, so `serverTime(now)` never runs backwards, and snaps when more than 0.25 s off. The welcome seeds a first
estimate (from the hello's send time) so states can go out at once.

## Relay

`new Relay({ now, ...options })` (`server/relay.ts`); `accept(transport, { room? })` for each connection (`room`:
the one its address named); `update()` about once
a second (timeouts, empty rooms); `flush()` every `batchInterval` if batching; `shutdown()`. `server/ws.ts`
`listen({ port, host?, relay?, tickMs? })` wraps it on a `ws` server and returns `{ relay, port, close() }`.

Joining: the first hello for a room code creates the room with the hello's circuit (or `defaultCircuit`,
melbourne). Later joiners get the room's circuit in the welcome whatever they asked for. Player ids count up
1..255 and wrap, skipping ids in use, so a leaver's late packets are not taken for a newcomer's. Duplicate names
in a room get " 2", " 3". An empty room is kept `roomLinger` (60 s) with its board.

Limits (`RELAY_DEFAULTS`):

| Limit | Default | On breach |
|---|---|---|
| players per room | 8 (`MAX_PLAYERS` env, 1-32) | `roomFull`, closed |
| rooms / connections | 256 / 2048 | `serverFull`, closed |
| client message size | 256 bytes (also `ws` `maxPayload`) | `tooBig`, closed (over WebSocket `ws` closes with 1009 itself) |
| car states | 60 a second, burst 30 (told in the welcome as `stateHz`) | dropped; every 10th drop is a violation |
| other messages | 20 a second, burst 40 | dropped, violation |
| violations (bad or excess messages; they decay at 2 a second) | 50 | `malformed` / `rate`, closed (kicked) |
| hello | within 5 s of connecting, first message, protocol 1, for the room the address names (if it names one) | `idle` / `notJoined` / `version` / `badRoom`, closed |
| idle (nothing at all from a joined client; clients ping every 2 s) | 10 s | `idle`, closed; others see `leave` reason timeout |
| name | sanitised: NFC, whitespace collapsed, control/format/private-use characters removed (so bidi overrides and zero-width characters), at most two combining marks in a row, 16 characters, 48 bytes; empty after that is refused | `badName` (fatal in a hello) |
| car / circuit | in `NET_CARS` / `NET_CIRCUITS` | `badCar` / `badCircuit` (fatal in a hello) |
| a car state's time | within 5 s before to 2 s after the relay clock | dropped silently |
| text frames (WebSocket) | binary only | closed |

Before forwarding a car state the relay checks it as the decoder would (`stateValid`), copies it and writes the
sender's id at offset 1. A `contact` goes to the other car's client only (refused with `badContact` if that player
is not in the room or is the sender); a `restart` to everyone else; a `player` change, accepted `lap`s and the
`board` to everyone.

Lap claims: `verifyLap(claim, options)` decides (default `plausibleLap`): time at least `minLapSecs` (40, or per
circuit) and at most 3600 s; a valid lap has three positive sectors adding up to the time within 2 ms; the player
has been in the room, and since its last accepted lap, at least the lap time less 1 s; it sent a car state in the
last 2 s. A refused claim gets `lapRejected` (not fatal) and is neither forwarded nor on the board. Accepted laps
are forwarded (valid or not); valid ones update the board: one row per player and car, best time and its sectors,
valid lap count, best first, at most 32 rows; a leaver's rows stay with player 0. The hook for real verification:
a later protocol version can carry the lap's inputs in the claim, and a `verifyLap` that replays them headlessly
(the game's `Session` runs in Node) can replace the plausibility check; `verifyLap` is synchronous now, so a
replaying verifier would need the claim held pending (a small change in `Relay.lap`).

Batching (`batchInterval`, `BATCH_MS` env, default 0): instead of one frame per car state, the relay queues them
per recipient (a newer state from the same car replaces a queued one) and sends one `states` bundle each flush.

### Bandwidth, 8 players at 40 Hz

Measured payload (`test/net-relay.test.ts`, `NET_REPORT=1`), and on the wire estimated with WebSocket framing (6
bytes a frame from a client, 2 from the relay) and 40 bytes of TCP/IPv4 headers per frame (each frame its own
segment: the worst case):

| | up per player | down per player | relay out, total |
|---|---|---|---|
| payload, no batching | 1.69 KB/s (41 frames/s) | 11.5 KB/s (275 frames/s) | 92 KB/s |
| on the wire, no batching | ~3.6 KB/s | ~23 KB/s (~185 kbit/s) | ~180 KB/s |
| on the wire, batching 1/60 s | ~3.6 KB/s | ~14 KB/s (61 frames/s) | ~109 KB/s |

Batching costs up to its interval (8 ms on average at 1/60 s) of extra delay on every remote car.

## Running the relay

    npm run server                         # builds build/server/server.mjs (vite.server.config.ts), listens on 8787
    PORT=9000 HOST=127.0.0.1 MAX_PLAYERS=12 BATCH_MS=16 npm run server
    MIN_LAP_SECS=60 npm run server         # the shortest lap the board takes (default 40)

The build bundles `src/net` into one module and leaves `ws` as an import (from this repository's `node_modules`).
It logs rooms opening, joins, leaves, refused laps and kicks to stdout; SIGINT / SIGTERM send every client a
`shutdown` error and close. It speaks plain `ws://`: put TLS (`wss://`, which a page served over https needs) in
front of it with a reverse proxy, or use the Cloudflare relay (**On Cloudflare**, **Going live**).

## On Cloudflare (`server/cf/`)

The same `Relay` on Cloudflare Workers with Durable Objects, on the Free plan, so the relay can sit next to a site
on Cloudflare Pages and be reached over `wss://` without a server of your own.

    npm run relay:cf        # wrangler dev: the Worker and its objects locally in workerd, ws://127.0.0.1:8787, no account
    npm run relay:deploy    # wrangler deploy (needs `npx wrangler login` first)

- **Routing.** The Worker (`fetch` in `worker.ts`) reads the room from the address (`roomFromPath`) before anything
  else: `/room/CODE` with a valid code and an `Upgrade: websocket` header goes to the room's object
  (`env.ROOMS.getByName(CODE)`: one object per room code, created on first use); a bad code is 400, no upgrade
  426, any other path 404 (`/`: a line of text), none of which creates an object. The object (`RelayRoom`) checks
  the code again, accepts the socket (`WebSocketPair`, `accept()`) and hands it to its `Relay` with `{ room }`, so
  a hello for another room is refused (`badRoom`). Old clients that connect without `/room/` get 404.
- **One room per object.** The object's `Relay` has `maxRooms: 1` and `maxConnections: maxPlayers + 8` (8 for
  joiners still on their hello and a reconnect while the old socket times out); everything else is the Node
  relay's code and defaults, with `MAX_PLAYERS`, `BATCH_MS` and `MIN_LAP_SECS` from the Worker's `vars` (in
  `wrangler.jsonc`; `server/env.ts`, checked as on Node). The Node relay's global limits (256 rooms, 2048
  connections per process) have no counterpart: there is no registry of rooms. What protects the Worker as a
  whole: only a valid `/room/CODE` upgrade reaches an object, every connection still has the relay's hello
  timeout (5 s), rate limits and kicks, an object takes at most `maxPlayers + 8` sockets, and the Free plan's daily
  allowances are a hard stop (no bill). Anyone can still open valid codes; each costs a request, so a flood can use
  up the day's allowance (a denial of service, not a cost). A Cloudflare rate-limiting rule could cap that per IP
  on a custom domain (not set up; not checked for `workers.dev`).
- **Plain WebSockets, no hibernation.** Cars send 40 states a second, so an object with players never has the idle
  time the Hibernation API needs; the object stays in memory while anyone is connected.
- **Timers.** A 1 s `setInterval` runs `relay.update()` (hello and idle timeouts, the empty room's linger) only while
  the object has connections, plus a `flush()` timer if `BATCH_MS` is set; the tick that finds no connections left
  stops them, so an empty object does no work and Cloudflare evicts it. The first connection after a quiet spell
  runs `update()` first, so a room that outlived `roomLinger` (60 s) is dropped then. As on Node, the room and its
  board survive an empty spell of up to `roomLinger`, but only while the object stays in memory (eviction loses
  them sooner; the relay stores nothing). No alarms: nothing has to happen while nobody is connected.
- **Differences from `server/ws.ts`.** A Workers WebSocket has no `bufferedAmount`, so the relay cannot drop car
  states for a backed-up client (`UNRELIABLE_BACKLOG`): they queue. The platform's own message limit (32 MiB) is far
  above the relay's 256 bytes, which the relay enforces itself (`tooBig`, kicked; on Node `ws` closes with 1009).
  `binaryType` is set to `arraybuffer` (at this compatibility date the default is `blob`).

### Clock

The relay clock is `(performance.now() - start) / 1000` in the object. In Workers `performance.timeOrigin` is 0
and `performance.now()` equals `Date.now()`; deployed, neither advances while code runs, only after I/O (the
"time of the last I/O"; a Spectre mitigation), and under `wrangler dev` they advance regardless. Measured under
local workerd (2026-11-17, a scratch Worker): `timeOrigin` 0, `performance.now()` equal to `Date.now()`, whole
milliseconds (successive distinct readings exactly 1 ms apart), and a 20 ms busy loop read as 20 ms (the local
runtime does not freeze it). The resolution deployed is not documented; this assumes whole milliseconds there too.

What that does to clock sync: the relay reads the clock when it handles a ping and sends the pong in the same
event, so the freeze costs only that handler's CPU time (microseconds). Whole milliseconds make each pong's
`serverTime` up to 1 ms low. The part common to everyone cancels (only the difference between two clients' clocks
moves a proxy); the rest leaves each client's offset (the lowest-RTT of its last 16 pings) off by 0-1 ms on its
own, so two clients disagree by up to 1 ms more than on Node (about 0.33 ms on average for two independent
uniform errors): up to 9 cm, about 3 cm on average, of proxy position at 90 m/s, against the 6-17 cm the proxy
errors above already have. A ping queued behind other events in the object biases its client by half the wait
(inbound delay only); with 8 players the object handles about 330 messages a second, each in microseconds, so the
queue is short. Not measurable locally: the asymmetry of the path client -> nearest Cloudflare location -> the
object's location (each object lives near where it was first created, so a far player has a long, possibly
asymmetric, path), which no ping can detect (**Measured accuracy** above).

Measured in the browser (two headless Chromium pages on one room, each the game with `?autopilot`, the F1 at
Melbourne, local relays; rendering switched off so both ran at 60 fps and 120 ticks a second, a scratch CDP script
comparing each page's proxy of the other car with the other page's own car at the same wall-clock time, and each
page's relay clock estimate at the same moment):

| Relay (local) | proxy error, mean | p50 | p95 | max | clocks disagree, mean / p95 / max | RTT |
|---|---|---|---|---|---|---|
| Cloudflare (`wrangler dev`, workerd) | 0.042 / 0.046 m | 0.027 / 0.028 m | 0.105 / 0.120 m | 2.6 / 2.7 m | 0.71 / 1.90 / 1.90 ms | 11 ms |
| Node (`npm run server`) | 0.071 / 0.061 m | 0.036 / 0.039 m | 0.143 / 0.144 m | 6.8 / 6.9 m | 0.88 / 1.77 / 2.02 ms | 9-11 ms |

170 s each (about 8,400 samples each way; the two numbers are each page's view of the other), both cars lapping in
116.5-116.6 s, and both laps on both pages' boards. The two relays are within run-to-run noise of each other: the
1 ms clock steps did not show (the clock disagreement includes the pages' own `performance.now()` coarsening and
`timeOrigin`s). The maxima are single moments in both runs (not looked into; the cars drove the same line a
second or so apart). This is local workerd, whose clock advances during execution and has no real network path:
it checks the room logic, the routing and the 1 ms steps, not the deployed clock (**Going live**: what stays open).

### Limits (Cloudflare's documentation, read 2026-11-17)

| | Free plan | Source |
|---|---|---|
| Durable Object requests | 100,000 a day (reset 00:00 UTC) | Durable Objects pricing (updated 2026-11-13) |
| Durable Object duration | 13,000 GB-s a day, billed on 128 MB per object whatever it uses | same |
| WebSocket messages | incoming billed as requests at 20:1 (100 messages = 5 requests); outgoing free; WebSocket protocol pings free; the connection itself is a request | same |
| Duration with `accept()`ed (non-hibernating) WebSockets | billed the whole time a socket is connected | same |
| Storage backend | SQLite-backed classes only (`new_sqlite_classes` in the migration) | same |
| Over a free limit | "further operations of that type will fail with an error" until the reset | same |
| Worker requests | 100,000 a day; over it, error 1027 | Workers limits (updated 2026-11-13) |
| Worker CPU | 10 ms per HTTP request (the routing uses microseconds) | same |
| Object CPU | 30 s per incoming request or WebSocket message (SQLite-backed) | Durable Objects limits |
| WebSocket message size | 32 MiB received | same |
| Requests per object | soft limit 1,000 a second ("overloaded" errors past it) | same |
| WebSockets per object | no figure given ("thousands of clients per instance") | WebSockets best practices (updated 2026-10-30) |
| Clock | `Date.now()` / `performance.now()` frozen during execution, advance after I/O; `timeOrigin` 0 | Workers security model, Performance API (updated 2026-10-27) |

### Capacity on the Free plan

Requests bind first. A player in a room sends 40 states a second plus a ping every 2 s: 40.5 messages a second,
2.025 billed requests a second at 20:1, 7,290 an hour. 100,000 a day / 7,290 = **about 13.7 player-hours a day**
(4 players for 3.4 hours, 8 for 1.7), less a request or two per join. Duration: 13,000 GB-s / 0.125 GB = 104,000 s,
**about 28.9 hours a day of a room with anyone in it**, however many players; one room-hour uses 3.5% of the day's
duration while each player-hour uses 7.3% of the requests, so duration runs out first only if most rooms hold a
single player for long (it cannot: at one player the requests last 13.7 h, the duration 28.9 h). A tab in the
menu still sends states at the full rate (paused); a hidden tab sends about one a second.

When a limit is hit: past the requests, new connections fail (the Worker answers 503 when it cannot reach the
object; the game says it could not reach the relay) and, presumably, so do messages on open sockets (not
documented, not checked), so players see "Disconnected"; past the Worker's own requests, the upgrade gets error
1027. Either way until 00:00 UTC. Nothing is billed on the Free plan.

Cheaper options (not done; the send rate is unchanged): clients sending 30 states a second (`sendHz`, the lowest
the protocol takes) would be 1.525 requests a second, about 18.2 player-hours a day, at some proxy accuracy at high
latency; a client-side bundle of two states per message (a protocol change) would halve the requests for 25 ms
more delay. Neither would change the Node relay.

### Going live

Nothing here has been run against a real account (the tests and checks above are local); these are the steps.

1. **Account.** A free Cloudflare account. On this machine: `npx wrangler login` (opens the browser to authorise
   wrangler).
2. **Relay.** `npm run relay:deploy` (`wrangler deploy -c server/cf/wrangler.jsonc`). On an account without a
   `workers.dev` subdomain it first asks for one. It uploads the Worker `fast-roads-relay`, creates the
   `RelayRoom` Durable Object class (SQLite-backed, migration `v1`) and prints the Worker's address,
   `https://fast-roads-relay.<subdomain>.workers.dev`. Check it: `curl https://fast-roads-relay.<subdomain>.workers.dev/`
   prints `fast-roads relay: open a WebSocket to /room/CODE`. **The relay address for the game is
   `wss://fast-roads-relay.<subdomain>.workers.dev`** (no path: the game adds `/room/CODE`).
   Settings (`MAX_PLAYERS`, `BATCH_MS`, `MIN_LAP_SECS`) go in `vars` in `server/cf/wrangler.jsonc`, then deploy
   again; keep `MAX_PLAYERS` at 24 or less (at 40 Hz that keeps an object under the 1,000 requests a second soft
   limit, if WebSocket messages count towards it, which the documentation does not say). A deploy restarts the
   objects, so everyone in a room is disconnected (a reload rejoins). Logs: `npx wrangler tail -c
   server/cf/wrangler.jsonc`, or the Worker's Observability tab in the dashboard.
3. **Site.** Dashboard: Workers & Pages -> Create -> Pages -> Connect to Git, pick this repository, then:
   production branch `main`; framework preset None; build command `npm run build`; build output directory `dist`;
   root directory empty; environment variables (Production, and Preview if wanted) `VITE_RELAY_URL` =
   `wss://fast-roads-relay.<subdomain>.workers.dev` and `NODE_VERSION` = `24` (vite 8 and vitest 5 need Node
   22.12+, 24 or 26+). Save and deploy; the site is `https://<project>.pages.dev`. `VITE_RELAY_URL` is read at build
   time, so changing it needs a new build (retry the deployment). Without Git: `VITE_RELAY_URL=wss://... npm run build`
   and `npx wrangler pages deploy dist --project-name <project>`. The repository root has no wrangler config, so
   Pages does not mistake the relay's (`server/cf/`) for its own.
4. **Play.** On the site, Race tab -> Multiplayer: a room code, a name, Join (the relay field defaults to
   `VITE_RELAY_URL`), or share `https://<project>.pages.dev/?room=CODE`.

What stays open until it runs on Cloudflare: the deployed clock's resolution and the real paths' asymmetry
(**Clock**); whether open sockets keep working past the daily request allowance; how long an empty object takes to
be evicted and what duration it is billed meanwhile; whether incoming WebSocket messages count towards the
per-object 1,000 a second; that the Worker drops out of the path once it has handed the socket to the object (the
capacity above counts only the object's requests).

## Tests

`npm test` runs them (project `unit`, about 10 s together):

- `test/net-protocol.test.ts`: round trips, quantisation, clamping, time and sequence wrap, version peek, malformed
  input, fuzzing; the id lists against `CARS` / `TRACKS`; nothing in `src/` imports `ws`, `node:*` or `server/`.
- `test/net-clock.test.ts`: clock sync over the emulated link.
- `test/net-remote.test.ts`: the accuracy table above, staleness, dropping, interpolation, blending, snapping.
- `test/net-relay.test.ts`: relay and three (up to eight) NetClients over the emulated network: join and roster,
  state relay, spoofed ids, contacts, the lap board and refused laps, car changes, restarts, leaving, a dead link
  timing out, a full room, other versions and bad hellos, garbage and oversized messages, floods, bandwidth.
- `test/net-ws.test.ts`: the real `listen()` on an ephemeral port: NetClients over `WebSocketTransport`, raw `ws`
  sockets sending text, oversized frames, garbage, another version, or nothing; the room in the address (a bad
  one refused at the handshake, a hello for another room).
- `test/net-cf.test.ts`: the Cloudflare relay run locally by wrangler's `unstable_startWorker` (workerd, offline,
  no account; about 3 s with its startup), `MAX_PLAYERS` 3 and `MIN_LAP_SECS` 1 as vars: three NetClients joining,
  the roster, car states between all three, a contact reaching only its target, an accepted lap and the board, a
  refused lap, leaving; a fourth player refused from the full room while a client in another room sees nobody;
  bad room codes and other paths refused at the handshake (400 / 404), a hello for another room, garbage, an
  oversized frame, text, another version.
- `test/multiplayer.test.ts`: game Sessions joined through the relay with `Multiplayer` (above): proxy accuracy,
  a rear-end hit seen by both sides and by one, restarting onto an occupied spot, pausing, joins, car changes,
  leaving, a lap reaching the board.
