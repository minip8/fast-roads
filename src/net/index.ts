// The multiplayer client layer (docs/net.md): what the game imports. The relay lives in server/.
export { NetClient, type NetClientOptions, type NetEvent, type ClientStatus, type LeaveReason, type Vec3 } from './client';
export { ClockSync } from './clock';
export { RemoteCar, REMOTE_DEFAULTS, emptySample, type RemoteOptions, type RemoteSample, type TimedState } from './remote';
export { type CarState, emptyCarState, STATE_FLAG, STATE_BYTES, PROTOCOL_VERSION, ERROR, type BoardEntry, type PlayerInfo } from './protocol';
export { type Transport, type Lane, type TransportState } from './transport';
export { WebSocketTransport, relayUrl } from './websocket';
export { NET_CARS, NET_CIRCUITS, DEFAULT_CIRCUIT } from './ids';
