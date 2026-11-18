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
- The relay (`server/`) is thin: rooms, the roster, the host, the room's settings, a shared clock (ping/pong), the
  session's lap board, and race weekends: the phases timed on its clock, the grid, the weather, the race
  classification. It runs no physics. It forwards car states as the bytes the client sent, with the player byte
  overwritten by the sender's id, so a claimed id is never trusted.
- A room is created explicitly (a hello that creates it, with a code the client picks) or joined (a hello that
  joins an existing one); its creator is the host. Until the host starts a weekend a room is a lobby: a shared
  hot-lap session, everyone on track together, flying starts, best laps on a board. A weekend is practice
  sessions, qualifying and a race, then the lobby again with the results kept (**Race weekends**). The protocol is
  versioned (2: explicit rooms, rejoining, weekends); message types 0x27-0x2f are free for more.
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
| `src/net/race.ts` | race weekends: `RoomSettings` (defaults, ranges, `normaliseSettings`), `SessionInfo`, `Standing`, `raceStage` / `lightsLit`, `COMPOUND`, `CAR_REASON` |
| `src/net/weather.ts` | a session's weather: `weatherKeys` (the seeded generator), `weatherAt` (interpolation), `resolveWeather`, `seededRandom` |
| `src/net/ids.ts` | the car and circuit ids the relay accepts (`NET_CARS`, `NET_CIRCUITS`; the compiler and a test check they match `CARS` / `TRACKS`) |
| `src/net/index.ts` | what the game imports |
| `server/relay.ts` | `Relay`: rooms, limits and the weekend's phases, transport-agnostic; `plausibleLap`, `sanitiseName` |
| `server/weekend.ts` | the weekend's pure parts: `gridOrder`, `classify` |
| `server/env.ts` | `relayEnv`: `MAX_PLAYERS`, `BATCH_MS`, `MIN_LAP_SECS`, `WEEKEND_SCALE` from either server's environment; `scaledWeekend` |
| `server/ws.ts` | `listen({ port })`: the relay on a `ws` WebSocket server |
| `server/main.ts` | `npm run server` entry point |
| `server/cf/worker.ts` | the relay on Cloudflare: the Worker (routing) and `RelayRoom`, the Durable Object of one room |
| `server/cf/wrangler.jsonc` | its wrangler config (`server/cf/tsconfig.json`: type-checked with the Workers types) |

`ws` is used only by `server/`; a test checks nothing in `src/` imports it, `wrangler`, `cloudflare:*`, `node:*` or
`server/`. `src/net/ids.ts` and `src/net/weather.ts` import nothing and `race.ts` only `weather.ts` (the
compile-time check against the game's ids is `idsCheck.ts`, which nothing imports), so the Worker's typecheck sees
none of the game's DOM code.

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
relay" in client messages, "left" on the board, "none" for the host).

Messages that a client sends and the relay forwards (`state`, `contact`, `lap`, `restart`, `pit`) carry the player
byte at offset 1: the client writes 0 and the relay overwrites it with the sender's id before forwarding the same
bytes.

### Unreliable lane

`state` 0x01, both ways, 43 bytes (`STATE_BYTES`):

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
| 42 | u8 | bits 0-2 tyre compound (`COMPOUND`: 0 unknown, 1 soft, 2 medium, 3 hard, 4 inter, 5 wet; 6-7 unassigned); bits 3-5 reason (`CAR_REASON`: 0 none, 1 pits, 2 spectator, 3 ghost, 4 paused, 5 finished, 6 retired; 7 unassigned); bits 6-7 reserved (must be 0) |

Quantisation (half a step): position 0.5 mm, velocity 5 mm/s, angular velocity 0.5 mrad/s, rotation under 0.01
degrees (tested over 2000 random orientations), steer 0.005 rad. `encodeState` clamps out-of-range values and
writes non-finite ones as 0 (rotation as identity), so a broken local state never makes an undecodable packet.

The epoch goes up by one (mod 16) at every restart or teleport: receivers do not blend across a change, and
since every state carries it, a lost packet cannot hide a restart.

Byte 42 (protocol 2) is for displays: the relay checks only its reserved bits and nothing in `src/net` acts on it. The
game decides what it sets (e.g. reason pits in the pit lane, spectator for a spectator-driver, ghost while
`noCollide` after a restart or in one-shot qualifying, finished on a cool-down lap); a value a client does not
know shows as unknown. `CarState` / `RemoteSample` carry it as `compound` and `reason`.

`states` 0x02, relay to client only (batching, off by default): `u8 type | u8 n (1-32) | n x 43-byte state`
(whole state messages, player bytes set). Decoded as `{ type: 'states', states }`; `NetClient` handles it as n
states.

### Reliable lane

`player` record: `u8 id | str name (<= 48 bytes) | str car`.
`board` body: `u8 n (<= 32) | n x { u8 player (0 = has left) | str name | str car | u32 best | u32 s1 | u32 s2 | u32 s3 | u16 laps }`, sorted by best.
`settings` body (`RoomSettings`; numbers as sent, the relay clamps them): `str circuit | str car ('' = any) | u8 practice | u8 practiceMinutes | u8 qualifying (0 none, 1 timed, 2 oneShot) | u8 qualifyingMinutes | u8 raceLaps | u8 grid (0 qualifying, 1 random, 2 reversed, 3 joinOrder) | u8 pitStops | u8 tyreWear (tenths: 5 = 0.5) | u8 weather (0 dry, 1 damp, 2 wet, 3 changeable, 4 random) | u8 collisions (0/1) | u8 trackLimits (0 off, 1 on; read: any non-zero is on) | u16 finishSecs` (13 bytes after the two ids).
The `trackLimits` byte was `invalidPenalty` (s added per invalid race lap: 0, 1, 2, 3, 5 or 10) until the race's track
limits rule replaced it, in the same protocol version: an older client's seconds read as on, and a relay from before
the change reads the new client's 1 as a 1 s penalty per invalid race lap (and echoes it back as 1, which reads as on).
`session` body (`SessionInfo`; times are f64 relay seconds, -1 = none): `u8 phase (0 lobby, 1 practice, 2 qualifying, 3 race) | u8 index | u8 stage (0 running, 1 finishing, 2 results) | u8 flags (1 collisions, 2 oneShot) | f64 start | f64 end | f64 lightsAt | f64 goAt | f64 finishAt | u32 seed | u8 n (<= 32) | n x u8 grid`.
`weather` body (`WeatherInfo`): `f64 origin (relay time of session time 0) | u8 kind (0 dry, 1 damp, 2 wet, 3 changeable: what the keyframes were made as) | u8 n (1-64) | n x { u16 t (s from origin, strictly increasing) | u8 rain (/255) | u8 wet (/255) }`.
`standings` body: `u8 final (0/1) | u8 n (<= 32) | n x { u8 player | str name | str car | u8 status (0 racing, 1 finished, 2 dnf, 3 outOfTime) | u8 grid slot (255 none) | u16 laps | u32 time (us from lights out to the last crossing, penalties excluded; none before a lap) | u32 penalty (us: a missed stop) | u32 best (us; none) | u8 pits | u8 invalid }`, in classification order.

| Type | Name | Direction | Body after the type byte |
|---|---|---|---|
| 0x10 | hello | C->R | `u16 version | u8 mode (0 join, 1 create, 2 either) | u32 token (0 = none; a previous welcome's, to rejoin as that player) | str room | str name (<= 48 bytes) | str car | str circuit (may be empty: the relay's default; used only if this hello creates the room)` |
| 0x11 | welcome | R->C | `u16 version | u8 you | u32 token | str room | f64 serverTime (s) | u8 maxPlayers | u8 stateHz (the most states a second the relay takes; >= 1) | u8 host | u8 n (<= 32) | n x player (everyone, you included) | board body | settings body | session body | weather body | standings body` (the race under way; otherwise the last race's result, final, or none). The room's circuit is the settings' |
| 0x12 | joined | R->C | `player` |
| 0x13 | left | R->C | `u8 id | u8 reason` (0 left, 1 timeout, 2 kicked, 3 replaced: rejoined on another connection) |
| 0x14 | player | both | `player`. C->R: id 0, my new name and/or car; R->all (sender included): the player's name and car now |
| 0x15 | ping | C->R | `u32 nonce | f64 clientTime` |
| 0x16 | pong | R->C | `u32 nonce | f64 clientTime (echoed) | f64 serverTime` |
| 0x17 | contact | C->R->C | `u8 from (0 from the client) | u8 to | time32 | f32 ix, iy, iz | f32 px, py, pz | f32 closing` (35 bytes) |
| 0x18 | lap | C->R->all | `u8 player (0 from the client) | u16 lap (1-65535: the sender's count this session) | time32 crossing (of the line, ending the lap) | u32 time | u32 s1, s2, s3 | u8 valid (0/1)` (25 bytes) |
| 0x19 | board | R->all | board body |
| 0x1a | restart | C->R->others | `u8 player (0 from the client)` |
| 0x20 | settings | both | settings body. C->R: the host's new settings (all of them); R->all: the settings now |
| 0x21 | host | R->all | `u8 id`: the host now |
| 0x22 | control | C->R | `u8 action` (1 start, 2 skip, 3 abort) |
| 0x23 | session | R->all | session body: a new session, or a new stage of one |
| 0x24 | weather | R->all | weather body: at every session start, and further ahead when a session runs long |
| 0x25 | standings | R->all | standings body: the race classification, after every change |
| 0x26 | pit | C->R->all | `u8 player (0 from the client) | time32 at | u8 compound (0-7)` (7 bytes) |
| 0x1f | error | R->C | `u8 code | u8 fatal (0/1) | str message (<= 200 bytes)` |

`contact`: `i` is the impulse the sender's car received (N s, world axes); the other car takes the opposite. `p`
is the contact point (world, m, each axis within +-1e5), `closing` the closing speed along the contact normal
(0-200 m/s). |i| at most 1e6.

`hello` and `welcome` keep `u16 version` at offset 1 in every protocol version (`helloVersion(data)` reads it
without decoding the rest), so a relay can refuse a client of another version with a proper error. A version 1
game (before explicit rooms) gets `version`, fatal: "this relay speaks protocol 2, the game 1: update the game
(reload the page)".

Error codes (`ERROR`): 1 version, 2 roomFull, 3 badName, 4 badCar, 5 badCircuit, 6 badRoom (a hello for another room than the address names; a bad room code in a hello fails decoding, so it is `malformed`), 7 malformed, 8 rate,
9 tooBig, 10 idle, 11 notJoined, 12 lapRejected, 13 badContact, 14 serverFull, 15 shutdown, 16 noRoom (a join for
a room that does not exist), 17 roomTaken (a create for a code in use), 18 notHost, 19 badPhase (not now: settings
outside the lobby, start outside it, skip or abort in it), 20 pitRejected, 21 replaced (to the old connection of a
player that rejoined with its token). A fatal error is followed by the relay closing the connection. Not fatal:
12, 13, 18, 19 and 20; 3 and 4 on a player change (4 also for a car the room does not allow); 4 and 5 on a
settings change. The rest are fatal.

### Decoding

`decodeMessage(data)` returns `{ ok: true, msg }` or `{ ok: false, error }` and never throws. It rejects: an
empty frame, an unknown or reserved type, truncation, trailing bytes, invalid UTF-8, strings over their field's
limit, room codes and ids outside their alphabets, non-finite floats, a hello or welcome of another version, a
hello mode over 2, a quaternion whose three components square-sum over 1, gear outside -1..15, rpm over 30000, the
reserved flag bit or status bits, a `left` reason over 3, error/lap/collisions/final flags other than 0/1, a lap
without a time, over 3600 s or numbered 0, a board, roster, grid or standings over 32, a bundle of 0 or over 32
states or with any bad state, a contact out of range, an enum out of its list (hello mode, qualifying, grid order,
weather, phase, stage, standing status; a control action other than 1-3), session flags over 3, a negative
session start, a pit compound over 7, weather of 0 or over 64 keyframes or with times not increasing. Settings
numbers out of range decode (the relay clamps them). `stateValid(data)` is the
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
  mode: 'create',              // 'create' | 'join' | 'either' (the default: join, or create if there is none)
  circuit: 'monza',            // the circuit of a room this creates; the welcome says the room's circuit
  token: savedToken,           // optional: a previous welcome's net.token, to come back as the same player
  sendHz: 40,                  // default 40; capped by the welcome's stateHz (60)
  clock: () => performance.now() / 1000,   // stamps arrivals as they happen (recommended)
});
```

Constructor options: `room`, `name`, `car`, `mode?`, `circuit?`, `token?`, `sendHz?`, `clock?`, `timeout?` (s
without hearing the relay before giving up, default 15), `remote?` (`RemoteOptions` for every proxy). Throws on an
invalid room code, car or circuit id.

Creating: the game picks a code (e.g. 4 random characters of `A-Z0-9`), connects with `mode: 'create'` and, on an
`error` event with `ERROR.roomTaken` (fatal: the client closes), tries again with another code on a new
connection. Joining with `mode: 'join'` gets `ERROR.noRoom` if the room does not exist (any more). `'either'` is
version 1's behaviour, kept so the game works unchanged until it chooses (a `?room=` link that should not create a
room should use `'join'`).

| Member | |
|---|---|
| `update(now)` | every frame: handles what arrived, sends hello once the transport is open, pings (every 0.5 s for the first 6, then every 2 s), closes on `timeout` |
| `sendState(state: CarState, at)` | our car's state as of local time `at`; sent only once joined and when due by `at` (`sendHz`); returns whether it went. Call every tick or every frame |
| `sample(id, now, out, smooth = true)` | player `id`'s car at local time `now`, into `out` (a `RemoteSample` from `emptySample()`); null if no such player or nothing received yet |
| `takeEvents(): NetEvent[]` | what happened since the last call, in order |
| `sendContact({ other, at, impulse, point, closing })` | we hit player `other`'s proxy at local time `at`; `impulse` is what OUR car received |
| `sendLap({ time, sectors, valid, at? })` | a lap finished (every lap, valid or not), its line crossing at local time `at` (default: now, the `clock` option's or the last `update`'s). NetClient numbers the laps (1, 2, ... from each new session). Not sent while it could not count: spectating a race, or our race over (status not racing, or the results) |
| `sendPit({ compound, at? })` | a pit stop at local time `at` (default now), fitting `compound` (`COMPOUND`) |
| `sendRestart()` | we were put back at the start spot (bump `state.epoch` as well) |
| `setPlayer({ name?, car? })` | a new car or name; the relay answers with a `player` event (or `badCar` for a car the room does not allow) |
| `setSettings(partial)` | host, in the lobby: new settings, merged into `settings` and sent whole; the relay clamps them and answers with a `settings` event to all |
| `startWeekend()`, `skipSession()`, `abortWeekend()` | host: start the weekend (lobby only); end the session now (practice: the next; qualifying: the race; the race: its results; the results: the lobby); back to the lobby (any phase but the lobby). Others get `notHost`, the wrong phase `badPhase` |
| `close(reason?)` | leave |
| `status` | `'connecting'` (transport not open) / `'joining'` (hello sent) / `'joined'` / `'closed'` (`closeReason`) |
| `selfId`, `token`, `room`, `circuit`, `maxPlayers`, `sendHz` | from the welcome (`circuit` is `settings.circuit`). Keep `token` (e.g. in sessionStorage) to rejoin after a reload |
| `players: Map<id, PlayerInfo>` | everyone in the room, ourselves included |
| `remotes: Map<id, RemoteCar>` | everyone else's proxy |
| `board: BoardEntry[]` | the lap board (`{ player, name, car, best, sectors, laps }`, best first): the lobby's or the session's |
| `host`, `isHost` | the host's id; whether it is us |
| `settings: RoomSettings` | the room's settings (**Race weekends**) |
| `session: SessionInfo` | the session (phase) now |
| `weather: WeatherInfo` | the session's weather keyframes |
| `standings: Standing[]`, `standingsFinal` | the race classification under way; final: the race's result (kept in the lobby until the next race) |
| `collides(id)` | whether our car and player `id`'s collide in this session: collisions on, neither a spectator. `sample` sets `collidable` false when not |
| `isSpectator(id = us)`, `gridSlot(id = us)` | in a race: not on the grid (joined after it began); grid slot (0 = pole) or null |
| `raceStage(now)`, `lightsLit(now)` | `'grid' \| 'lights' \| 'racing' \| 'finishing' \| 'results'` (null outside a race); start lights lit, 0-5 |
| `held(now)` | our car must be held at its grid slot (a race before lights out) or in the pits (one-shot qualifying before our own release, `oneShotRelease`) |
| `timeLeft(now)` | s to the end of the session's current stage (null: none) |
| `conditions(now, out?)` | `{ rain, wet }` (0..1) now: `weatherAt(weather.keys, serverTime(now) - weather.origin)` |
| `raceLaps(id = us)` | laps completed in the race (from `standings`) |
| `serverTime(now)`, `rtt`, `jitter`, `clock` | relay clock and link quality (s) |
| `stats` | messages and bytes each way, states sent and received, `malformed`, `unknownSender` |

`CarState` (`emptyCarState()`): `x y z` (m), `qx qy qz qw`, `vx vy vz` (m/s), `wx wy wz` (rad/s, world axes),
`steer` (front wheel angle, rad, + = left), `throttle`, `brake` (0..1, as applied), `gear`, `rpm`, `flags`
(`STATE_FLAG.noCollide | paused | flapsOpen`), `epoch` (0-15), `compound` (0-7, `COMPOUND`), `reason` (0-7,
`CAR_REASON`). These map onto `Vehicle` as `pos`, `quat`, `vel`, `angv`, `steer`, `throttle`, `brake`, `gear`,
`rpm`, `flapsOpen`; `compound` and `reason` are the game's to set.

`RemoteSample` is a `CarState` plus `time` (relay time asked for), `age` (s past the newest state; negative when
sampling in the past), `extrapolated` (s actually extrapolated), `collidable`, `alpha` (1..0 as the proxy goes
stale, for drawing) and `correction` (m of correction still being blended out).

Events (`NetEvent`):

| `type` | Fields |
|---|---|
| `welcome` | `you, room, circuit, players, host, token` (followed by a `board` event; `settings`, `session`, `weather` and `standings` are already set) |
| `join` | `player` |
| `leave` | `player, reason: 'left' \| 'timeout' \| 'kicked' \| 'replaced'` |
| `player` | `player, before`: a name or car change (also our own, echoed) |
| `contact` | `from, time` (relay time), `impulse` (to apply to OUR car: already turned round), `point`, `closing` |
| `lap` | `player, lap, crossing` (relay time), `time, sectors, valid`: accepted laps only, ours included |
| `pit` | `player, time` (relay time), `compound`: accepted pit stops, ours included |
| `board` | `board` |
| `restart` | `player` |
| `host` | `host, before` |
| `settings` | `settings, before, circuitChanged`: on `circuitChanged` the game reloads onto the new circuit and rejoins (`mode: 'join'`, `token`) |
| `session` | `session, before`: a new session (phase, index or start differ) or a new stage of it |
| `weather` | `weather`: new keyframes (a session start, or more of them) |
| `standings` | `standings, final` |
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
      case 'session': if (e.session.start !== e.before.start) restartAtStartSpotOrGrid(); break;   // laps count from the session
      case 'settings': if (e.circuitChanged) reloadAndRejoin(e.settings.circuit, net.token); break;
      case 'error': if (e.fatal) showMessage(e.message); break;
      case 'closed': backToMenu(e.reason); break;
    }
  }

  // physics: fixed 120 Hz ticks; the proxies sampled at each tick's time, so collisions see where they are then
  while (accumulator >= DT) {
    const tickAt = now - (accumulator - DT);           // local time this tick's state is for
    for (const [id] of net.remotes) {
      const s = net.sample(id, tickAt, remote);          // (collidable false too when the session says so: collides(id))
      if (s?.collidable) placeCollider(id, s);           // kinematic body at s.x.., moving at s.vx.., spinning at s.wx..
      else removeCollider(id);
    }
    session.tick(net.held(tickAt) ? holdStill(input) : input);   // on the grid until the lights go out
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
// on a lap:    net.sendLap({ time: lap.time, sectors: lap.sectors, valid: lap.valid, at: crossingLocalTime });
// a pit stop:  net.sendPit({ compound: COMPOUND.medium, at });
// weather:     const { rain, wet } = net.conditions(now);
```

Contacts: when the other car's client resolves a hit, ours receives a `contact` event about a one-way trip later.
NetClient applies nothing; the game's rule is under **In the game** below.

## In the game (`src/multiplayer.ts`)

`Multiplayer(net, session, def)` joins one game `Session` (on circuit `def`) to a room. It has no DOM and no rendering, so
`test/multiplayer.test.ts` runs exactly this code with several Sessions in Node; the game adds `remoteCars.ts`
(the other cars drawn, name tags, minimap dots) and `netHud.ts` (the board), all loaded with `netGame.ts` by a
dynamic import, so a single-player page never downloads `src/net`.

| Member | |
|---|---|
| `update(now, paused)` | every frame, before the ticks: `net.update`, the events handled (roster, cars, contacts, laps), and returned for the game's own use (the circuit, errors, `closed`). `paused`: the game is not simulating (menu, before the first Drive) |
| `tick(input, autopilot, tickAt)` | in place of `session.tick`: proxies sampled at `tickAt` into `session.proxies`, the weekend's input (held, limiter, service), the tick, then contacts, laps (with the crossing's time: `at`) and our state sent. `tickAt` is the local time the tick's result is for (`now - (acc - DT)` in the frame loop) |
| `idle(now)` | a frame without ticks: our state, held, sent as paused |
| `players` | everyone else: `RemotePlayer` (info, spec, the proxy `body` and its `sample` at the last tick, `collidable`) |
| `noCollide`, `epoch`, `stats` | ours; `stats` counts contact ticks, events sent, applied, ignored, dropped, laps sent |
| `sampleAt(id, now, out)` | for drawing; the game draws other cars at `now - DT`, where the player's own car is drawn (interpolated a tick behind) |
| `takeNotices()` | joins, leaves, car changes, best laps, non-fatal errors, as text for the HUD's feed; kind `race` (a stop made, a drive-through, rain) for the feed too, `flag` (lights out with the stops required, final lap with "pit this lap" while a required stop is owed, the flag (not to the winner after its finish, nor a spectator), a track limits strike and the limiter penalty, a session starting) for the big message, with `sub` under it |
| `tick(input, autopilot, tickAt, parked)` | `parked`: the player is in the menu during a race (`weekend.keepsRunning`): the game keeps ticking, the car brakes to a stop, a ghost |
| `requestRestart()` | the restart key and the menu's Restart: what the weekend allows (below) |
| `weekend` | the race weekend as our car lives it (below) |

The weekend in the car (sessions, the grid, the pit lane, recoveries, conditions, the running order) is
`Multiplayer.weekend`, a `Weekend` (`src/weekend.ts`; **Race weekends in the game**, below). The menu side
(`main.ts`, `menu.ts`, `lobby.ts`) enters rooms: created (`mode: 'create'`, a code the game makes, another on
`roomTaken`) or joined (`mode: 'join'`; a `?room=` link never creates), the token kept in the tab's sessionStorage
and sent on every rejoin (a reload, a circuit change), a `settings` event with `circuitChanged` reloading onto the
circuit, and the host's settings, start, skip and abort, the session, the drivers, the starting tyre
(`weekend.setStartCompound`; Auto is null) and the standings in the menu's room tab. The menu refuses a car change
during the race and one-shot qualifying (a change puts the car back at the start: a second flying lap, or off the grid).

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

### Race weekends in the game (`src/weekend.ts`)

`Multiplayer.weekend` follows `net.session` (each frame, after the events) and decides everything about our car in it.
It has no DOM; `raceHud.ts` (the lights, the race strip, the pit panel, the pit guidance), `netHud.ts` (the board, a
timing tower in a race), `pitLaneMesh.ts` (the lane drawn) and the minimap (`Hud.setPitLane`: the lane and the box)
show it. Every client works the geometry out from the track alone
(`src/raceGeometry.ts`), so all agree on it.

**Conditions.** In a room the physics runs with tyre wear (`settings.tyreWear` x the car's `CarInfo.race.wearScale`:
1 for the F1 and the drift car, 4.1 for the GT3, whose tyres last 4.1 times the F1's laps at scale 1) and the relay's
weather (`net.conditions(now)` every 0.5 s into `Session.setConditions` as rain and wetness, rounded to 1/200; the
game draws `weekend.rain` / `weekend.wetness` with `weather.set`). The lobby is dry, with wear. Leaving the room puts
the time trial back (no wear, dry, no pit lane, the time trial's best times, a fresh set of the first compound and a
flying start). The wear steps are multipliers as the F1 wears; `weekend.tyreLife(compound)` turns the room's step
into laps for a menu ("soft about 4 laps"): at Melbourne at scale 1 the F1's soft, medium and hard last about 43, 64
and 90 laps, scaled here by the circuit's length (a rough figure: wear depends on the circuit's corners as much).
At 12 that is about 3.6, 5.3 and 7.5 laps. The menu's formats (`lobby.ts` `PRESETS`) pick the step per circuit so
the softs (wets for a wet race) last about 1.4 races where no stop is required, 0.65 with one and 0.45 with two
(`lobby.ts` `tyreLaps` is the same arithmetic without a `Weekend`).

**Best times and ghosts.** Laps in a room never touch the time trial's best times: `Session.setStoreTag('.mp')` in the
lobby, practice and qualifying (one set of "race conditions" bests per circuit and car, with its own ghost, which
practice and qualifying show), `'.race'` in a race, cleared at each race's start (the timing panel's BEST is the best
lap of this race), where the ghost car is not drawn (real cars are racing). The timing panel counts the race's laps
(`weekend.lapState`: ON THE GRID, LAP 2/5, FINISHED; SESSION OVER once a qualifying session is over for us).

**Where the car goes.** On each new session (phase, index or start differ) the session's tyres are fitted fresh
(`weekend.startCompound`, set by the menu, or Auto: `autoCompound()`, wets from wetness 0.65, intermediates
from 0.2 (just past where each starts to be faster), else the medium in a race and the soft otherwise) and the car is put:
- lobby (joining one: driving on where it is), practice, timed qualifying: the flying start (`Session.restart`).
- one-shot qualifying, an entrant: at rest in its own spot in the pit lane (the k-th entrant 8 + 10k m into the
  limited stretch, closer on a short one), off the racing line, held until its release, `oneShotRelease(session, id)`
  = `goAt + k x ONE_SHOT_GAP` (20 s; k its place in `grid`, the join order; a constant in `src/net/race.ts`, not on
  the wire and not scaled by `WEEKEND_SCALE`, so every client and the relay agree). Released, it waits on until no
  other car outside the pit lane is between 500 m before the start spot and 200 m after it (a car on its lap coming
  round: we never join in front of it, nor right behind; at most 15 s), then a flying start from the start spot.
  When its lap is in, it goes back to its spot in the pits, held for the rest of the session. In identical cars 20 s
  holds round the lap, so nobody drives in another's spray or sight line (a much quicker car can still catch one).
  A ghost all session (`collisions` is off). A joiner after the start: a flying start, laps not sent. The race strip
  shows our turn (OUT IN 0:40, OUT NEXT, YOUR LAP, DONE and our place) and who is on track and out next
  (`weekend.oneShotRunners(now)`, `oneShotIn(now)`).
- the race, on the grid: first a spawn at the start spot (a fresh car: full battery), then the grid slot
  (`gridSlots`, below) at rest, held until `goAt`. Lap 1 is timed from the tick the lights go out
  (`Timing.startStanding`: the first crossing of the line does not end it; sector 1 includes the run from the grid)
  and is reported with its crossing's relay time like every lap. A racer back after a reload (its token, the race
  under way): out of its pit box at rest, where the box serves it as at any stop (a stop reported and counted). A spectator (joined after the start): a flying start, a ghost, never
  classified.

While held, recovering or being serviced the input is replaced by a stop (the brake while it rolls, then nothing: a
brake held at a standstill is the automatic box's reverse).

**The grid** (`gridSlots(track, n)`): two staggered columns, slot k `8 + 8k` m behind the line (16 m nose to nose in a
column, 10 m clear in front of the 5.6 m F1), pole on the inside of the first corner, the columns 3 m either side of
the middle of the road (less where it is narrow: 1.6 m from the car's side to the edge). The 32 slots of a full room
reach 256 m back: on asphalt at every circuit (`test/raceGeometry.test.ts`).

**The pit lane** (`buildPitLane(track, def)`): a strip 4 m wide on the pit building's side (`TrackDef.pitSide`), its
inner edge 2 m beyond the track's edge, or nearer (into the track) so that its outer edge stays 0.6 m off the
barrier: on the run-off at the 19 permanent circuits (7 m of it), 1.1 m into the road at the five street circuits
(3.5 m of pavement). Along the lap it is centred on the pit building: a speed-limited stretch as long as the building
(at most 320 m: 120 m at Monaco), an entry and an exit ramp of 60 m, the box (12 m) in the middle. `enablePitLane` (a
room only) makes the ground asphalt and inside the track limits from the track's edge to the lane's outer edge all
along it, so the time trial's track and the pinned laps are untouched. A car is in the lane once its centre is in the
lane's outer half (beyond its middle less 1.2 m) and until it is back on the track (hysteresis); in it the car is a
ghost (reason `pits`), and an automatic limiter holds it to 80 km/h through the limited stretch and, on the entry
ramp, to what braking at 9 m/s² down to the limit line allows (above it: no throttle, the brake). Stopping in the
box (centre within 6 m of it, under 0.5 m/s) starts the service: `CarInfo.race.pitSecs` (F1 2.5 s, GT3 8 s, drift
car 6 s), then a fresh set of `weekend.nextCompound` out of the blankets and `sendPit` (the relay counts it in a race
after lights out); not once our race is over (finished, or our last lap in: the relay would refuse the stop).
Leaving the lane after going past the box (`pit.passedBox`) without a stop, in a race we are still racing in, is a
drive-through (a notice, nothing reported); leaving it otherwise is not (a brush with the lane's zone before the
box, the car moved out of it by a new session, our finish). Every session starts with the car out of the lane
(`pit.inLane` false): a car still in the lane when a session ended used to be told "Drive-through: no stop made" on
its next tick, wherever it was put (the reported notice; one-shot qualifying's cars wait in the lane, so every car
would have had it at the race's start). A restart (a recovery) is refused while the car is being serviced.

**The pit request** (`weekend.pitRequest`; the `pit` action, L or the d-pad down; `togglePitRequest`): "box this
lap". Driving into the lane turns it on (the action again in the lane turns it off: a drive-through); it goes off
once the car leaves the lane after a stop or past the box, and at each session. On, it fits tyres for the weather
to `nextCompound` if the fitted ones are wrong for it (`tyresWrong`: slicks above wetness 0.3, intermediates below
0.1 or above 0.8, wets below 0.5) and the player has not chosen the next set this session, and in the lane the
limiter also stops the car in the box: its speed falls as braking at `BOX_DECEL` (3 m/s²) to a stop at the box's
middle allows, so a car on full throttle comes to rest there (measured: 0.1 m from the middle, GT3 from the limit
line). Without it, a brake key pressed fully from 80 km/h stops a GT3 in the 12 m box only from about 10 to 22 m
before its middle (`test/pit-request.test.ts`). `weekend.pitGuide` is the HUD's step: `entry` (m to the lane's
start, its side), `lane` (m to the box, the limiter), `box` (under 40 m), `service` (s left), `go`, or `through`
(in the lane without the request). `weekend.pitAdvice` (a race we are racing in, no request): why to stop now, a
required stop owed with no more laps left to make one in than stops owed + 1, tyres wrong for the track, or a tyre
75% worn. Where the box is past the start/finish line (`weekend.boxPastLine`: the lane runs across the line, or
starts after it) the last lap's crossing in the lane is the finish, so no stop can be made on the last lap: the
advice comes a lap earlier, the lap before the last is told PIT THIS LAP while a required stop is owed, and the
final lap's message does not say "pit this lap". The
first session of a weekend (not one-shot qualifying) and the first request show `weekend.pitHelp` for 12 s, a
one-line explanation of pit stops. The autopilot never
enters it (it drives the centreline; in a room it treats the lane as road, so a car put in it, out of the box or
recovered, drives out). The start gantry's post on the pit side stands beyond the lane (`scenery.ts`). Measured (`PITLOSS=melbourne npx vitest run test/pit-loss.test.ts`: the
autopilot from the start spot to 300 m past the lane's end, through the lane with a stop, against on the track):
at Melbourne a stop costs the F1
19.7 s (38.3 s against 18.5 s; 2.5 s of it in the box), the GT3 23.8 s (8 s in the box), the drift car 21.1 s (6 s).

**Restarts.** The restart key (`Multiplayer.requestRestart`) and Session's own resets (a stuck autopilot, a car on its
roof: `Session.autoReset`): in the lobby, practice and timed qualifying a flying start on a fresh set of
`nextCompound`; in a race (racing) and in one-shot qualifying after the release a **recovery**: the car put back on
the track at the nearest point (in the pit lane, the lane's middle; else at most 2 m inside the edge), at rest, the
lap going on, and held there for `RECOVERY_SECS` (5 s) as a ghost: with the standing start after it, a recovery
costs well over 5 s, so it is a last resort, and it never gains ground. Nothing on the grid before the lights.

**Track limits in a race** (the room setting `trackLimits`; `strikes.ts` `Strikes`, `weekend.strikes`). In a race we
are racing in (past the lights, not finished, not a spectator), each excursion beyond the track limits is a strike:
all four wheels out, as `Timing` deletes a lap, however it came about (pushed off by another car too; going the wrong
way is none). The car must be back within the limits (a wheel inside them) for `REJOIN_SECS` (0.5 s) before going
off again counts again. Every `STRIKES_PER_PENALTY`th strike (3: `src/net/race.ts`) earns the penalty limiter and
starts the count again: `LIMITER_PENALTY_SECS` (3 s) during which `Weekend.input` cuts the throttle whenever the car is
faster than the pit lane's limit (`PIT.limitKmh`, 80 km/h); it never brakes for the driver. The 3 s start once the car
is back within the limits (not served in the gravel) and run only while it is driven (not held, recovering, serviced
or parked). Notices (`flag`): TRACK LIMITS 1/3 and 2/3, TRACK LIMITS 3/3 with the penalty, LIMITER PENALTY when it
starts; the pit panel shows the strikes (TRACK LIMITS 1/3), the penalty waiting (REJOIN THE TRACK) and its seconds
left. `weekend.addStrike(reason)` adds a strike for any rule (the notice reads `reason`, upper case, and the count):
false, not counted, outside a race we are racing in or with the setting off. The rule is the client's alone: the relay
only carries the setting. A race lap off the track is still reported invalid (it is not a best lap) but costs no time.
Practice and qualifying keep the time trial's rule (the lap deleted), with no strikes.

**Pausing in a race.** A race does not stop for one player: while the menu is open (or before the first Drive) in a
race we are in, the game keeps simulating our car (`weekend.keepsRunning`) with the input parked (it brakes to a stop
where it is), a ghost (reason `paused`); the race clock and the others go on, and the menu's title says so
(`MenuHost.net.raceGoesOn`). A hidden tab gets no frames: the car is
then frozen and sent as paused, as in every other session. In the lobby, practice and qualifying the menu pauses as
before.

**Laps.** Every completed lap is sent with the relay time of its crossing (`at`: the tick's time less the part of
the tick after the crossing), except: one-shot qualifying's laps after our first from the release (and every lap of
a non-entrant); timed qualifying's laps after the flag beyond the first (sent only if it began before the flag + 1 s);
a race's after our finish (NetClient does not send them either). In a race `Timing.runup` is 0: going off before the
line costs only the lap under way. Our session over (finished, one-shot lap done, qualifying's last lap), we drive on
as a ghost (reason `finished`).

**Running order** (`weekend.order`, 10 times a second in a race): every classified car's distance since the start,
its track position (the proxy at the tick, ours) unwrapped tick to tick and put right by the standings' lap counts
(beyond 50 m of slack); finished cars first in the standings' order, then by distance. Gaps come from each car's
timing loops (when it passed every 10 m, over the last lap): a car's gap to the leader is the time since the leader
passed its distance, `gapAhead` / `gapBehind` likewise; more than a lap: `lapsDown`.

**Car state byte.** `compound` is the fitted set (`COMPOUND`; the drift car's all-weather tyre is unknown); `reason`
pits / spectator / paused (parked, or the menu) / finished / ghost (recovering, one-shot, after a restart until clear)
/ none. Other cars' compound shows on their name tags, the board and the tower, and reason `pits` as PIT.

| `Weekend` member | |
|---|---|
| `phase`, `index`, `stage`, `raceStage` | the session as we acted on it |
| `startCompound`, `setStartCompound(id \| null)` | the set every session starts on (null: `autoCompound()`), for the lobby screen |
| `nextCompound`, `cycleCompound(dir)` | the set the next stop or restart fits (the HUD's NEXT TYRES; action `tyre`, N or d-pad up) |
| `tyreLife(id, wear?)` | about how many laps a set lasts here at the room's wear (or `wear`: the menu's hint next to the host's choice) |
| `pit` | `zone`, `inLane`, `limiter`, `dist` (m along the lane), `service` / `serviceTotal` (s), `stops`, `stopped`, `passedBox` (this visit) |
| `pitRequest`, `togglePitRequest()`, `setPitRequest(on)`, `pitGuide`, `pitAdvice`, `tyresWrong()`, `pitHelp` / `pitHelpFor` | the pit request and its guidance (above) |
| `mandatoryStops` | the race's `pitStops` |
| `held`, `recovering`, `parked`, `finished`, `spectator`, `raceLaps` | |
| `strikes` (`count`, `pending`, `left`, `serving`, `limiting`), `addStrike(reason)` | the race's track limits rule (above) |
| `order`, `gapAhead`, `gapBehind`, `aheadId`, `behindId` | the live running order (`RaceEntry`: id, name, car, pos, laps, dist, gap, lapsDown, status, compound, pits, inPits, penalty) |
| `keepsRunning`, `inRace`, `reason`, `lapState` | |
| `rain`, `wetness` | the relay's weather now |
| `oneShotRunners(now)`, `oneShotIn(now)`, `oneShotDone` | one-shot qualifying: each entrant's release and state (waiting, out, done: its lap in), s to our release |
| `lane` | the pit lane (`PitLane`) |

## Race weekends

The relay runs them; clients follow its messages. Everything below is timed on the relay clock and every
transition is announced (`session`, reliable) with the new session's times, so clients need no timers of their own
beyond `serverTime(now)`.

**Settings** (`RoomSettings`, `src/net/race.ts`; the host sets them in the lobby, the relay validates ids, clamps
the rest with `normaliseSettings` and broadcasts them; `defaultSettings(circuit)` for a new room):

| Field | Values (default) | |
|---|---|---|
| `circuit` | a circuit id (the creator's) | changing it resets the board and the kept results; clients reload onto it (`settings` event `circuitChanged`) |
| `car` | `''` any, or one car id (`''`) | a `player` change to another car is refused (`badCar`), so is a lap in another; a hello in another car is accepted (the game switches after the welcome). The game makes a room it creates one-car (its creator's) at once, in its default format (`lobby.ts` `newRoomSettings`): the relay's own default stays `''` |
| `practice`, `practiceMinutes` | 0-3 (1), 1-120 (10) | sessions and their length |
| `qualifying`, `qualifyingMinutes` | `none` / `timed` / `oneShot` (`timed`), 1-60 (10) | |
| `raceLaps` | 1-99 (5) | |
| `grid` | `qualifying` / `random` / `reversed` / `joinOrder` (`qualifying`) | with qualifying `none`, `qualifying` and `reversed` become `joinOrder` |
| `pitStops` | 0-3 (0) | mandatory stops in the race |
| `tyreWear` | 0.5-20 in steps: 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 12, 15, 20 (1; nearest) | for the game's tyre model (as the F1 wears: each car's own is scaled to match, **Race weekends in the game**); the relay only passes it on |
| `weather` | `dry` / `damp` / `wet` / `changeable` / `random` (`dry`) | **Weather** |
| `collisions` | on / off (on) | in the race; practice and timed qualifying always collide, one-shot qualifying never |
| `trackLimits` | on / off (off) | the race's track limits rule, the game's (**Track limits in a race**); invalid laps cost no time either way |
| `finishSecs` | 30-600 (120) | the others' time to finish after the winner |

The host is the room's creator. When the host leaves, the role is held `hostGrace` (10 s) for it to come back with
its token (a reload: the welcome still names it as host meanwhile, and nobody can change settings); then it goes to
the player in the room longest (a rejoiner keeps its original join time), and everyone gets `host`. With the room
empty it waits for the next joiner. Only the host sends `settings` (lobby only) and `control`.

**Phases** (`SessionInfo`: `phase`, `index`, `stage`, `start`, `end`, `lightsAt`, `goAt`, `finishAt`, `seed`,
`grid`, `collisions`, `oneShot`):

1. `lobby`: free driving as in protocol 1 (flying starts, the board), no end. `start` (host) begins the weekend.
2. `practice` 1..n: `end = start + practiceMinutes x minute` (`minute` 60 s), then the next practice, or
   qualifying, or the race.
3. `qualifying`, timed: running until `end` (the flag), then stage `finishing` with `finishAt` = the flag and `end`
   = the flag + `overtimeSecs` (180): a lap that began before the flag (crossing - time <= flag + 1 s) still counts;
   each player's first accepted lap after the flag ends their session (their later laps are refused); it ends when
   everyone in the room has had one, or at `end`. The board is its result: a player's best valid lap in any car.
4. `qualifying`, one-shot (`oneShot`, `collisions` off): `grid` lists who takes part (everyone in the room at the
   start, by join order); the first is released at `goAt = start + oneShotPrep` (10 s) and the others one at a
   time, `ONE_SHOT_GAP` (20 s) apart in `grid` order (`oneShotRelease`: the clients hold their cars until then; the
   relay does not police it), each from the start spot (flying), with one lap: the first lap accepted from it,
   which must have begun at or after `goAt`, ends its session (an invalid one counts as its lap, with no time).
   Joiners after the start drive but are not timed. It ends when every entrant still in the room has had its lap,
   or at `end = goAt + (n - 1) x ONE_SHOT_GAP + oneShotLimit` (420 s after the last of the n releases: 560 s
   after `goAt` for 8 entrants).
5. `race`: the grid is fixed at its start from the players in the room (`grid`, slot = index; order from the
   setting: by qualifying best, its reverse, a shuffle from the room's seeded generator, or join order; players
   without a qualifying time after those with one, in join order). `lightsAt = start + gridSecs` (15 s); the five
   lights come on a second apart (all five at `lightsAt + 4`) and go out at `goAt`, a uniformly random 0.2-3 s
   after the fifth, chosen when the race starts and announced with it. Clients hold their cars until `goAt`
   (`held(now)`), so there is no jump start to police; the relay refuses any lap that could have begun before
   `goAt`. While running, `end` is a safety stop at `goAt + raceLaps x maxRaceLapSecs` (600 s).
   The first car to complete `raceLaps` laps wins: stage `finishing`, `finishAt` = its crossing, `end` = that +
   `finishSecs`; every other car finishes at its first crossing after `finishAt`. The race ends (stage `results`,
   standings final, `end` = now + `resultsSecs` (30 s)) when no car is still racing (all finished or gone), at
   `end`, or when the host skips; cars still racing then are `outOfTime`. Then the lobby, with the result kept
   (`standings`, final) until the next race's result replaces it or the circuit changes.

Each session start resets the board (lobby too), the per-player lap numbering and the weather, and comes with a
`weather` and a `board` message after the `session`. The host can end the current session or stage at once
(`skip`: practice -> the next, qualifying -> the race (no overtime), race -> results, results -> lobby) or `abort`
to the lobby from anywhere (the race unfinished, its result not kept). The game should put every car back at the
start spot (practice, qualifying) or its grid slot (race) on each new session; a lap that began before the session
did is refused.

Laps: every client reports every lap it completes (`sendLap`: lap number, the relay time of the line crossing, the
lap time, sectors, valid), in every phase. The race's first lap is timed from `goAt` (it includes the run from the
grid slot to the line). Pit stops (`sendPit`: time, compound fitted) count in the race after `goAt`; in other
phases they are only passed on.

Classification (`server/weekend.ts` `classify`, broadcast as `standings` after every race lap, pit stop, retirement
and stage change; clients compute the live running order between laps from the cars' positions and these lap
counts): cars still classified (racing, finished, outOfTime) by laps completed, then by the time of their last
crossing plus penalties, then grid slot; cars that left (`dnf`) after them. Penalty: `missedStopPenalty` (60 s) once
the race is over for a car that made fewer than `pitStops` stops (invalid laps are counted, `invalid`, but cost no
time). `time` is the last crossing less `goAt`, without the penalty.

Joining mid-weekend: in the lobby, practice and qualifying a joiner is a driver (in the race grid if it starts
while they are in). During a race a joiner is a spectator-driver: on track, not on the grid (`isSpectator`),
never collided with (`collides` is false both ways), not classified, its laps and stops refused (NetClient does not
send them). A player who leaves the race is `dnf`; if it rejoins with its token (same id) while the race runs it is
racing again, its laps kept.

Rejoining: the welcome's `token` (u32, random, unique in the room) in a later hello, within the room's life (the
relay keeps the last 64 leavers' tokens), gives back the same player id (unless taken meanwhile), its join time,
its board rows, the host role (within `hostGrace`) and its race entry. If the token's player is still connected
(a reload before the old socket timed out), that connection is closed first (`replaced`; others see `leave`
reason `replaced`, then `join`). A token is a bearer secret: anyone who has it can take the player's place.

Durations: `RelayOptions` `minute`, `gridSecs`, `lightsHold`, `resultsSecs`, `overtimeSecs`, `oneShotPrep`,
`oneShotLimit`, `maxRaceLapSecs`, `hostGrace`, `pitSpacing` (5 s between a car's stops) are injectable; the
`WEEKEND_SCALE` env (0.001-1) multiplies all of them on either server (tests: `scaledWeekend(k)`).

Deadlines: each room keeps its next deadline (stage end, host hand-over, weather extension). The relay runs every
deadline due, each at its own time (the next session starts at the previous one's `end` exactly, however late the
timer ran), whenever `update()` runs or a message from that room arrives, and calls `RelayOptions.schedule(at)`
when the earliest deadline changes; both servers set a timer for it, so phase changes do not wait for the 1 s tick.

### Weather

`src/net/weather.ts`: at each session start the relay makes keyframes `{ t, rain, wet }` (s from the session
start; rain intensity and track wetness 0..1 in steps of 1/255) from the `weather` setting and the session's
`seed`, one a minute for 63 minutes (64 keyframes), and sends them with the session's start as `origin`; ten
minutes before the last one it sends 64 more from two minutes before then (`weatherKeys(setting, seed, first, 64)`:
the same generator, so they agree with the first batch where they overlap), up to the wire's 18 hours. Clients
interpolate linearly: `weatherAt(keys, t)` (held before the first and after the last), `net.conditions(now)`.
Dry weather is two keyframes of nothing (0 and 65535 s) and never extended. The lobby is always dry.

The model: rain comes in showers, a two-state Markov chain a minute (chance of a shower starting / stopping) with
an intensity per shower that wanders a little; the rain ramps towards it by at most 0.25 a minute. Wetness follows:
dW/dt = r (1 - W) / 150 s - max(0, 1 - 3 r) W / 900 s, so heavy rain soaks the track in a few minutes, drizzle (r
over a third) holds it, and it dries over about a quarter of an hour. Per kind: `damp` starts at 0.3-0.5 wet with
occasional drizzle (0.05-0.2); `wet` starts at 0.75-0.95 and rains most of the time (0.35-0.85); `changeable`
starts at 0-0.3 with showers of 0.2-0.9 coming and going (about half the minutes dry); `random` is dry (40%),
changeable (30%), damp or wet (15% each) by the seed (`resolveWeather`; the message says which). Measured over 60
seeds and 64 minutes (`test/net-weather.test.ts`): damp rain at most 0.2 and mean wetness 0.1-0.6; wet mean rain
over 0.35 and wetness over 0.75; changeable 30-80% of minutes dry and showers over 0.6.

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
the one its address named); `update()` about once a second (timeouts, empty rooms, deadlines) and at the time
`schedule(at)` asks for; `nextDeadline()`; `flush()` every `batchInterval` if batching; `shutdown()`.
`server/ws.ts` `listen({ port, host?, relay?, tickMs? })` wraps it on a `ws` server and returns `{ relay, port,
close() }`.

Joining: a hello with mode `create` makes the room (refused with `roomTaken` if the code is in use, also by an
empty room still lingering) with the hello's circuit (or `defaultCircuit`, melbourne) and default settings, and
its sender is the host; `join` needs the room to exist (`noRoom`); `either` joins or creates. Joiners get the
room's settings, session, weather and standings in the welcome whatever circuit they asked for. Player ids count
up 1..255 and wrap, skipping ids in use, so a leaver's late packets are not taken for a newcomer's (a rejoin with
a token gets its old id back). Duplicate names in a room get " 2", " 3". An empty room is kept `roomLinger` (60 s)
with its board, settings and weekend (whose deadlines still run, on Cloudflare caught up at the next connection).

Limits (`RELAY_DEFAULTS`):

| Limit | Default | On breach |
|---|---|---|
| players per room | 8 (`MAX_PLAYERS` env, 1-32) | `roomFull`, closed |
| rooms / connections | 256 / 2048 | `serverFull`, closed |
| client message size | 256 bytes (also `ws` `maxPayload`) | `tooBig`, closed (over WebSocket `ws` closes with 1009 itself) |
| car states | 60 a second, burst 30 (told in the welcome as `stateHz`) | dropped; every 10th drop is a violation |
| other messages | 20 a second, burst 40 | dropped, violation |
| violations (bad or excess messages; they decay at 2 a second) | 50 | `malformed` / `rate`, closed (kicked) |
| hello | within 5 s of connecting, first message, protocol 2, for the room the address names (if it names one); `create` for a free code, `join` for an existing room | `idle` / `notJoined` / `version` / `badRoom` / `roomTaken` / `noRoom`, closed |
| idle (nothing at all from a joined client; clients ping every 2 s) | 10 s | `idle`, closed; others see `leave` reason timeout |
| name | sanitised: NFC, whitespace collapsed, control/format/private-use characters removed (so bidi overrides and zero-width characters), at most two combining marks in a row, 16 characters, 48 bytes; empty after that is refused | `badName` (fatal in a hello) |
| car / circuit | in `NET_CARS` / `NET_CIRCUITS` | `badCar` / `badCircuit` (fatal in a hello) |
| a car state's time | within 5 s before to 2 s after the relay clock | dropped silently |
| text frames (WebSocket) | binary only | closed |

Before forwarding a car state the relay checks it as the decoder would (`stateValid`), copies it and writes the
sender's id at offset 1. A `contact` goes to the other car's client only (refused with `badContact` if that player
is not in the room or is the sender); a `restart` to everyone else; a `player` change, accepted `lap`s and `pit`s,
the `board`, `settings`, `host`, `session`, `weather` and `standings` to everyone.

Lap claims: first the weekend's rules (**Race weekends**: a car the room allows; in a race on the grid, still
racing, not in the results; one-shot: an entrant's first lap; after the flag: begun before it), then
`verifyLap(claim, options)` (default `plausibleLap`): time at least `minLapSecs` (40, or per circuit) and at most
3600 s; a valid lap has three positive sectors adding up to the time within 2 ms; the lap number above the last
accepted this session (gaps allowed: a refused lap does not use one up); the crossing no more than 1 s in the
future and no more than 10 s in the past of the relay clock, and after the previous accepted crossing; the player
has been in the room, and since its last accepted lap (arrival), at least the lap time less 1 s; the crossing at
least the lap time less 1 s after the earliest the lap could have begun (`startRef`: the session's start, in a
race `goAt`, in one-shot qualifying `goAt` (the first release), or the previous crossing, whichever is latest); it sent a car
state in the last 2 s. A refused claim gets `lapRejected` (not fatal, with the reason) and is neither forwarded nor
on the board nor counted. Pit stops: the time within 1 s ahead and 10 s behind, at least `pitSpacing` after the
car's previous stop, and in a race from a car still racing after `goAt`; otherwise `pitRejected`. Accepted laps
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
| payload, no batching | 1.73 KB/s (41 frames/s) | 11.8 KB/s (275 frames/s) | 94 KB/s |
| on the wire, no batching | ~3.6 KB/s | ~23 KB/s (~187 kbit/s) | ~182 KB/s |
| on the wire, batching 1/60 s | ~3.6 KB/s | ~14 KB/s (61 frames/s) | ~111 KB/s |

Batching costs up to its interval (8 ms on average at 1/60 s) of extra delay on every remote car. Protocol 2's
43-byte state (one byte more than protocol 1's, for the compound and the reason) adds 40 B/s up and 280 B/s down
per player here (2.4%). The weekend's reliable messages are rare: a race lap is a 25-byte `lap` and a `standings`
of about 30 bytes a car to everyone, a few times a minute per car.

## Running the relay

    npm run server                         # builds build/server/server.mjs (vite.server.config.ts), listens on 8787
    PORT=9000 HOST=127.0.0.1 MAX_PLAYERS=12 BATCH_MS=16 npm run server
    MIN_LAP_SECS=60 npm run server         # the shortest lap the board takes (default 40)
    WEEKEND_SCALE=0.1 npm run server       # every weekend duration x 0.1 (a settings minute is 6 s): for trying it out

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
  the object has connections, plus a `flush()` timer if `BATCH_MS` is set, plus a `setTimeout` for the relay's next
  phase deadline (`schedule`); the tick that finds no connections left stops them all, so an empty object does no
  work and Cloudflare evicts it. The first connection after a quiet spell runs `update()` first, so a room that
  outlived `roomLinger` (60 s) is dropped then, and deadlines that passed meanwhile are run, each at its own time.
  As on Node, the room, its board and its weekend survive an empty spell of up to `roomLinger`, but only while the
  object stays in memory (eviction loses them sooner; the relay stores nothing, so a `join` then gets `noRoom`). No
  alarms: nothing has to happen while nobody is connected.
- **Rooms that do not exist.** A `join` for a code nobody created reaches a fresh object (the Worker cannot know),
  whose `Relay` has no room: it refuses the hello (`noRoom`, fatal) and closes, and with no connections left its
  timers stop at the next tick. A later `create` of that code on the same object works.
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

Protocol 2 changes none of this: requests are billed per message, not per byte, so the state's extra byte costs
nothing, and a weekend adds only a handful of client messages (a lap report per lap, a pit report per stop, the
host's few settings and controls): at a 90 s lap, 0.011 messages a second per player against 40.5, under 0.03%.
The relay's own messages (session, standings, weather) are outgoing, which is free. The phase deadline timer is a
few wake-ups per session while the object is awake anyway.

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
   time, so changing it needs a new build (retry the deployment). It must be a build variable: a runtime variable
   of a Worker (wrangler `vars`) never reaches `vite build`. The repository's `.env.production` sets it to the
   deployed relay, which the build reads when the environment has none. Without Git: `VITE_RELAY_URL=wss://... npm run build`
   and `npx wrangler pages deploy dist --project-name <project>`. The repository root has no wrangler config, so
   Pages does not mistake the relay's (`server/cf/`) for its own.
4. **Play.** On the site, the Online tab: Create room, then Copy invite link (`https://<project>.pages.dev/?room=CODE`)
   for the others, who open it or type the code under Join room (the relay defaults to `VITE_RELAY_URL`).

What stays open until it runs on Cloudflare: the deployed clock's resolution and the real paths' asymmetry
(**Clock**); whether open sockets keep working past the daily request allowance; how long an empty object takes to
be evicted and what duration it is billed meanwhile; whether incoming WebSocket messages count towards the
per-object 1,000 a second; that the Worker drops out of the path once it has handed the socket to the object (the
capacity above counts only the object's requests).

## Tests

`npm test` runs them (project `unit`, about 20 s together):

- `test/net-protocol.test.ts`: round trips, quantisation, clamping, time and sequence wrap, version peek, the track
  limits byte (an older client's seconds read as on), malformed input, fuzzing; the id lists against `CARS` / `TRACKS`; nothing in `src/` imports `ws`, `node:*` or `server/`.
- `test/net-clock.test.ts`: clock sync over the emulated link.
- `test/net-remote.test.ts`: the accuracy table above, staleness, dropping, interpolation, blending, snapping.
- `test/net-relay.test.ts`: relay and three (up to eight) NetClients over the emulated network: join and roster,
  state relay, spoofed ids, contacts, the lap board and refused laps, car changes, restarts, leaving, a dead link
  timing out, a full room, other versions and bad hellos, garbage and oversized messages, floods, bandwidth.
- `test/net-weekend.test.ts`: rooms and weekends in-process over the emulated network, the relay's durations
  shortened (a settings minute is 5 s, the grid 1 s): create / join / a taken code / a missing room / `either`, a
  version 1 hello (update needed), the host held for its grace then handed to the longest present, rejoining with
  a token (same id, host kept, an old connection replaced), settings permissions, clamping, a one-car room, a
  circuit change; `normaliseSettings` and every grid order; a whole weekend with three clients (practice, timed
  qualifying with overtime, a race gridded from it, the lights, a lap before lights out refused, pit stops,
  a missed-stop penalty reordering the finish (an invalid lap costing nothing), a DNF, results, the lobby keeping them);
  one-shot qualifying; a spectator joining mid-race and a racer rejoining it; skip and abort; bad and out-of-order
  lap and pit reports; deadlines met at their own times with the schedule asked for, a race nobody is left in;
  weather keyframes from the session seed and their extension in a long session.
- `test/net-weather.test.ts`: the weather generator, deterministic and in range for every kind, each kind's
  character, wetness following rain, interpolation.
- `test/net-ws.test.ts`: the real `listen()` on an ephemeral port: NetClients over `WebSocketTransport`, raw `ws`
  sockets sending text, oversized frames, garbage, another version, or nothing; the room in the address (a bad
  one refused at the handshake, a hello for another room); a taken code, and a practice session ending on the
  deadline timer, not the 1 s tick.
- `test/net-cf.test.ts`: the Cloudflare relay run locally by wrangler's `unstable_startWorker` (workerd, offline,
  no account; about 8 s with its startup), `MAX_PLAYERS` 3, `MIN_LAP_SECS` 1 and `WEEKEND_SCALE` 0.05 as vars:
  three NetClients joining, the roster, car states between all three, a contact reaching only its target, an
  accepted lap and the board, a refused lap, leaving; a fourth player refused from the full room while a client in
  another room sees nobody; create, a taken code, a join to a missing room refused (and that object taking a create
  afterwards), notHost, settings, a practice ending into the race on the object's deadline timer, skip, the results
  ending into the lobby, the host handed on; bad room codes and other paths refused at the handshake (400 / 404), a
  hello for another room, garbage, an oversized frame, text, another version.
- `test/multiplayer.test.ts`: game Sessions joined through the relay with `Multiplayer` (above): proxy accuracy,
  a rear-end hit seen by both sides and by one, restarting onto an occupied spot, pausing, joins, car changes,
  leaving, a lap reaching the board.
- `test/race-weekend.test.ts`: whole weekends of game Sessions (the F1, the GT3, the drift car) on a relay with short
  durations: wear and store tags in the lobby and sessions, timed qualifying setting the grid, every car on its own
  slot and held there at full throttle until lights out, the standing lap 1, the live order, a pit stop (into the
  lane at 30 m/s, the limiter, the box, the service: hards fitted, wear gone, the stop in every client's standings,
  a ghost to the others, the compound in its state), the limiter's 80 km/h, a recovery (put back where it was,
  held, a ghost, its lap going on), the timing panel's race laps (`lapState`) and a best lap from an earlier race not
  carried in, the finish and the classification with missed-stop penalties (no chequered flag for the winner after
  its FINISHED), the time trial's
  best times untouched, leaving back to the time trial.
- `test/pit-request.test.ts`: a stop made from the guidance alone (entry, lane, box, service, go; the stop in the
  standings, no drive-through), the assisted stop against a brake key's window, when a drive-through is told (past
  the box with the request off) and when not (a brush with the lane, the session ending with the car in it).
- `test/oneshot.test.ts`: one-shot qualifying with two, three and eight entrants in game Sessions: each waiting in
  its own pit-lane spot, released in the session's order `ONE_SHOT_GAP` apart (never two cars out of the lane at
  once), a car due out waiting while one on its lap comes past the start spot, one lap sent, back to the pits, the
  relay's end allowing for the last release, the grid by it; ghosts, the wet weather in the physics and wets fitted
  for it, a spectator joining mid-race.
- `test/track-limits.test.ts`: the race's track limits rule in a game Session: no strike in practice, one strike per
  excursion however long (and a wheel back in for a moment is not back), the third's penalty waiting off the track,
  then 3 s of driving with the throttle cut only above 80 km/h and the driver's brake untouched, the count again from
  zero, `addStrike` for another rule; the setting off (no strikes); `Strikes` on its own.
- `test/raceGeometry.test.ts`: the grid (32 slots) and the pit lane at every circuit, the lane's ground and track
  limits only while enabled, the start gantry's pit-side post beyond the lane.
