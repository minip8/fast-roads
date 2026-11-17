import { DurableObject } from 'cloudflare:workers';
import { roomFromPath, truncUtf8 } from '../../src/net/protocol';
import type { Lane, Transport, TransportState } from '../../src/net/transport';
import { relayEnv } from '../env';
import { Relay, RELAY_DEFAULTS } from '../relay';

// ============================================================================
// The relay on Cloudflare Workers (`npm run relay:cf` locally, `npm run relay:deploy`; docs/net.md, **On
// Cloudflare**). The Worker routes each WebSocket to one Durable Object per room, by the /room/CODE at the end of
// the address (the code checked first, so junk addresses never create an object); the object runs the same Relay
// as `npm run server`, for its one room. Plain (non-hibernating) WebSockets: cars send 40 states a second, so an
// object with players never has the idle time hibernation needs. The 1 s timeout timer runs only while the object
// has connections; with none it does no work and Cloudflare evicts it (and the room's board with it).
// ============================================================================
export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>;
  MAX_PLAYERS?: string; BATCH_MS?: string; MIN_LAP_SECS?: string;
}

// Connections an object takes beyond its players: joiners still sending their hello, and the slack for a
// reconnect while the old socket times out. More is refused (serverFull) before the hello is read.
const SPARE_CONNECTIONS = 8;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const room = roomFromPath(url.pathname);
    if (room === undefined) {
      return url.pathname === '/' ? new Response('fast-roads relay: open a WebSocket to /room/CODE\n') : new Response('not found\n', { status: 404 });
    }
    if (room === null) return new Response('bad room code\n', { status: 400 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade\n', { status: 426 });
    try {
      return await env.ROOMS.getByName(room).fetch(req);
    } catch (err) {   // e.g. the day's Durable Object requests used up (docs/net.md, **Capacity on the Free plan**)
      console.log(`room ${room}: ${err instanceof Error ? err.message : String(err)}`);
      return new Response('relay unavailable\n', { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;

export class RelayRoom extends DurableObject<Env> {
  private readonly relay: Relay;
  private room: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batch: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const opt = relayEnv(env as unknown as Record<string, unknown>);
    const maxPlayers = opt.maxPlayers ?? RELAY_DEFAULTS.maxPlayers;
    // performance.now() is Date.now() in Workers (timeOrigin 0), whole ms, and does not advance while code runs:
    // every reading in one event is the time the event started (docs/net.md, **On Cloudflare**, Clock).
    const start = performance.now();
    this.relay = new Relay({
      ...opt, maxRooms: 1, maxConnections: maxPlayers + SPARE_CONNECTIONS,
      now: () => (performance.now() - start) / 1000,
      log: (line) => console.log(line),
    });
  }

  async fetch(req: Request): Promise<Response> {
    const room = roomFromPath(new URL(req.url).pathname);
    if (!room || (this.room !== null && room !== this.room)) return new Response('bad room code\n', { status: 400 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade\n', { status: 426 });
    this.room = room;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    if (!this.timer) this.relay.update();   // first connection after a quiet spell: drop the room if it outlived roomLinger
    this.relay.accept(new SocketTransport(server), { room });
    this.startTimers();
    return new Response(null, { status: 101, webSocket: client });
  }

  // relay.update() every second while anyone is connected; stopped with the last connection, so an empty object
  // does nothing and can be evicted.
  private startTimers() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.relay.update();
      if (this.relay.connectionCount === 0) this.stopTimers();
    }, 1000);
    const iv = this.relay.opt.batchInterval;
    if (iv > 0) this.batch = setInterval(() => this.relay.flush(), iv * 1000);
  }
  private stopTimers() {
    if (this.timer) clearInterval(this.timer);
    if (this.batch) clearInterval(this.batch);
    this.timer = this.batch = null;
  }
}

// The relay's side of a Workers WebSocket. Both lanes share it. Unlike server/ws.ts it cannot drop car states when
// the socket is backed up: a Workers WebSocket has no bufferedAmount.
class SocketTransport implements Transport {
  onOpen: (() => void) | null = null;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  state: TransportState = 'open';
  private notified = false;

  constructor(private readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';   // (at this compatibility date the default is 'blob', as in browsers)
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') { this.close('text frame'); return; }
      this.onMessage?.(new Uint8Array(ev.data as ArrayBuffer));
    });
    ws.addEventListener('close', (ev) => {
      try { ws.close(1000, 'closed'); } catch { /* already closed */ }   // answer the client's close
      this.finish(ev.reason || `closed (${ev.code})`);
    });
    ws.addEventListener('error', () => this.finish('socket error'));
  }

  send(_lane: Lane, data: Uint8Array) {
    if (this.state !== 'open') return;
    try { this.ws.send(data); } catch { this.finish('send failed'); }
  }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    try { this.ws.close(1000, truncUtf8(reason, 120)); } catch { /* already closing */ }
    this.finish(reason);
  }

  private finish(reason: string) {
    this.state = 'closed';
    if (this.notified) return;
    this.notified = true;
    this.onClose?.(reason);
  }
}
