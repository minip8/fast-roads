// The multiplayer client layer (docs/net.md): what the game imports. The relay lives in server/.
export { NetClient, type NetClientOptions, type NetEvent, type ClientStatus, type LeaveReason, type Vec3 } from './client';
export { ClockSync } from './clock';
export { RemoteCar, REMOTE_DEFAULTS, emptySample, type RemoteOptions, type RemoteSample, type TimedState } from './remote';
export {
  type CarState, emptyCarState, STATE_FLAG, STATE_BYTES, PROTOCOL_VERSION, ERROR, type BoardEntry, type PlayerInfo, type HelloMode,
  type WeatherInfo, isRoomCode,
} from './protocol';
export {
  type RoomSettings, defaultSettings, normaliseSettings, SETTING_RANGES, QUALIFYING, type Qualifying, GRID_ORDERS, type GridOrder,
  TYRE_WEAR, INVALID_PENALTIES, type SessionInfo, type Phase, type Stage, type RaceStage, raceStage, lightsLit, LIGHTS, ONE_SHOT_GAP, oneShotRelease,
  type Standing, type StandingStatus, COMPOUND, CAR_REASON,
} from './race';
export { WEATHER_KINDS, type WeatherKind, type WeatherKey, type Conditions, weatherAt, weatherKeys, resolveWeather } from './weather';
export { type Transport, type Lane, type TransportState } from './transport';
export { WebSocketTransport, relayUrl } from './websocket';
export { NET_CARS, NET_CIRCUITS, DEFAULT_CIRCUIT } from './ids';
