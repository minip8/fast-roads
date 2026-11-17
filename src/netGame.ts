import { ERROR, type HelloMode, NetClient, relayUrl, WebSocketTransport } from './net';
import { joinErrorText, type JoinOffer } from './lobby';
import { newRoomCode } from './netPrefs';

// ============================================================================
// Multiplayer in the game: what main.ts imports dynamically when a room is joined or created (so a single-player
// page never downloads src/net or the rest of it).
// ============================================================================
export { Multiplayer } from './multiplayer';
export { NetHud } from './netHud';
export { RemoteCars } from './remoteCars';
export * as lobby from './lobby';

// code: the relay's ERROR code that refused us (null: the relay was never reached); text and offer: for the player.
export type Joined = { ok: true; net: NetClient } | { ok: false; code: number | null; text: string; offer?: JoinOffer };
export interface ConnectOptions { server: string; room: string; name: string; car: string; circuit: string; mode: HelloMode; token?: number; timeout?: number }

// Connects to the relay and enters the room (mode: join an existing room, or create one with this code); resolves
// once in (the welcome: net.circuit is the room's circuit), or with the reason it could not (the relay unreachable
// or silent within `timeout` s, or its error).
export function connect(o: ConnectOptions): Promise<Joined> {
  const clock = () => performance.now() / 1000;
  let net: NetClient;
  try {
    net = new NetClient(new WebSocketTransport(relayUrl(o.server, o.room)), { room: o.room, name: o.name, car: o.car, circuit: o.circuit, mode: o.mode, token: o.token, clock });
  } catch (err) {
    return Promise.resolve({ ok: false, code: -1, text: err instanceof Error ? err.message : String(err) });
  }
  const until = clock() + (o.timeout ?? 8);
  return new Promise((resolve) => {
    let error: { code: number; message: string } | null = null, opened = false;
    const pump = () => {
      net.update(clock());
      opened ||= net.status === 'joining';   // (the socket opened and the hello went)
      if (net.status === 'joined') { clearInterval(timer); resolve({ ok: true, net }); return; }
      // (only events from before the welcome are taken here: the welcome and board stay for Multiplayer to see)
      for (const e of net.takeEvents()) if (e.type === 'error') error = { code: e.code, message: e.message };
      if (net.status === 'closed' || clock() > until) {
        clearInterval(timer);
        if (net.status !== 'closed') net.close('timeout');
        const code = error ? error.code : opened ? -1 : null;
        resolve({ ok: false, code, ...joinErrorText(code, o.room, o.server, error?.message ?? (opened ? `The relay at ${o.server} did not answer.` : '')) });
      }
    };
    const timer = setInterval(pump, 30);
  });
}

// A new room with a code of its own: tries fresh codes while the relay says one is taken (up to `tries`).
export async function createRoom(o: Omit<ConnectOptions, 'room' | 'mode' | 'token'>, room = newRoomCode(), tries = 5): Promise<Joined> {
  for (let k = 0; ; k++) {
    const r = await connect({ ...o, room, mode: 'create' });
    if (r.ok || r.code !== ERROR.roomTaken || k + 1 >= tries) return r;
    room = newRoomCode();
  }
}
