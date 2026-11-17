// ============================================================================
// A connection between a client and the relay, as the net code sees it: two lanes, one reliable and ordered, one
// unreliable (packets may be lost, duplicated or reordered; nothing above this interface may assume otherwise,
// whatever the implementation actually does: WebSocket carries both lanes in order, WebRTC data channels will not).
// Implementations: loopback.ts (in-process, emulated network, for tests), websocket.ts (browser / Node WebSocket),
// server/ws.ts (the relay's side of a `ws` socket).
//
// Incoming messages are delivered through onMessage as they arrive; consumers that run on explicit update(now)
// calls (NetClient) queue them. A message is one whole frame (the lanes carry messages, not a byte stream).
// ============================================================================
export type Lane = 'reliable' | 'unreliable';
export type TransportState = 'connecting' | 'open' | 'closed';

export interface Transport {
  readonly state: TransportState;
  // Sends one message. On a transport that is not open it is dropped. The unreliable lane may also drop it when the
  // link is backed up (a stale car state is worth less than none).
  send(lane: Lane, data: Uint8Array): void;
  // Closes the connection (onClose is called once, also when the other side closes or the link fails).
  close(reason?: string): void;
  onOpen: (() => void) | null;
  onMessage: ((data: Uint8Array) => void) | null;
  onClose: ((reason: string) => void) | null;
}
