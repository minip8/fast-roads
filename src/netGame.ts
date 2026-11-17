import { NetClient, relayUrl, WebSocketTransport } from './net';

// ============================================================================
// Multiplayer in the game: what main.ts imports dynamically when a room is joined (so a single-player page never
// downloads src/net or the rest of it).
// ============================================================================
export { Multiplayer } from './multiplayer';
export { NetHud } from './netHud';
export { RemoteCars } from './remoteCars';

export type Joined = { ok: true; net: NetClient } | { ok: false; error: string };

// Connects to the relay and joins the room; resolves once joined (the welcome: net.circuit is the room's circuit),
// or with the reason it could not (relay unreachable, refused, nothing heard within `timeout` s).
export function connect(o: { server: string; room: string; name: string; car: string; circuit: string; timeout?: number }): Promise<Joined> {
  const clock = () => performance.now() / 1000;
  let net: NetClient;
  try {
    net = new NetClient(new WebSocketTransport(relayUrl(o.server, o.room)), { room: o.room, name: o.name, car: o.car, circuit: o.circuit, clock });
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  const until = clock() + (o.timeout ?? 8);
  return new Promise((resolve) => {
    let error = '', opened = false;
    const pump = () => {
      net.update(clock());
      opened ||= net.status === 'joining';   // (the socket opened and the hello went)
      if (net.status === 'joined') { clearInterval(timer); resolve({ ok: true, net }); return; }
      // (only events from before the welcome are taken here: the welcome and board stay for Multiplayer to see)
      for (const e of net.takeEvents()) if (e.type === 'error') error = e.message;
      if (net.status === 'closed' || clock() > until) {
        clearInterval(timer);
        if (net.status !== 'closed') net.close('timeout');
        resolve({ ok: false, error: error || (!opened ? `Could not reach the relay at ${o.server}`
          : `The relay at ${o.server} did not let us in${net.closeReason && net.closeReason !== 'timeout' ? ` (${net.closeReason})` : ''}`) });
      }
    };
    const timer = setInterval(pump, 30);
  });
}
