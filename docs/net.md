# Multiplayer networking

The networking layer for multiplayer: `src/net/` (browser-safe, shared by the game and the relay) and `server/`
(the Node relay). Nothing in the game uses it yet; this document is what the integration is written from. The
source of truth for the byte layout is `src/net/protocol.ts`: keep the two in step.

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
| `server/ws.ts` | `listen({ port })`: the relay on a `ws` WebSocket server |
| `server/main.ts` | `npm run server` entry point |

`ws` is used only by `server/`; a test checks nothing in `src/` imports it, `node:*` or `server/`.

## Wire format

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

Error codes (`ERROR`): 1 version, 2 roomFull, 3 badName, 4 badCar, 5 badCircuit, 6 badRoom (reserved: a bad room code fails decoding, so it is `malformed`), 7 malformed, 8 rate,
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

Contacts: when the other car's client resolves a hit, ours receives a `contact` event a round trip later. If our
own simulation saw a contact with that car around `e.time` (within a window of about the RTT), it was already
applied and the event is to be ignored; otherwise apply `e.impulse` at `e.point`. Deciding that window, and
whether to split hits by mass, is the integration's job; nothing here applies anything.

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

`new Relay({ now, ...options })` (`server/relay.ts`); `accept(transport)` for each connection; `update()` about once
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
| hello | within 5 s of connecting, first message, protocol 1 | `idle` / `notJoined` / `version`, closed |
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

The build bundles `src/net` into one module and leaves `ws` as an import (from this repository's `node_modules`).
It logs rooms opening, joins, leaves, refused laps and kicks to stdout; SIGINT / SIGTERM send every client a
`shutdown` error and close. It speaks plain `ws://`: put TLS (`wss://`, which a page served over https needs) in
front of it with a reverse proxy.

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
  sockets sending text, oversized frames, garbage, another version, or nothing.
