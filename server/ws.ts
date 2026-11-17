import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { MAX_CLIENT_MSG, roomFromPath, truncUtf8 } from '../src/net/protocol';
import type { Lane, Transport, TransportState } from '../src/net/transport';
import { Relay, type RelayOptions } from './relay';

// ============================================================================
// The relay on a WebSocket server (the `ws` package): every socket becomes a Transport handed to Relay.accept. Both
// lanes share the socket; the unreliable one drops a message rather than queue it behind more than
// UNRELIABLE_BACKLOG unsent bytes (a client on a slow link gets fewer car states, not later ones).
// No compression (car states do not compress, and permessage-deflate costs memory per socket).
// Any path is accepted; one ending in /room/CODE (what the game opens: relayUrl) ties the connection to that room
// (a hello for another is refused), and /room/<not a room code> is refused at the handshake (HTTP 400), as the
// Cloudflare relay does.
// ============================================================================
export const UNRELIABLE_BACKLOG = 32 * 1024;

export interface ListenOptions {
  port: number;                   // 0: any free port (see RelayServer.port)
  host?: string;
  relay?: Partial<Omit<RelayOptions, 'now'>>;
  tickMs?: number;                // how often relay.update() runs (default 1000)
}

export interface RelayServer {
  readonly relay: Relay;
  readonly port: number;
  close(): Promise<void>;
}

export function listen(opt: ListenOptions): Promise<RelayServer> {
  const start = performance.now();
  // phase deadlines (a session's end, lights out...): a timer for the next one, so they do not wait for the tick
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const schedule = (at: number | null) => {
    if (deadline) clearTimeout(deadline);
    deadline = null;
    if (at == null) return;
    deadline = setTimeout(() => { deadline = null; relay.update(); }, Math.max(0, (at - relay.opt.now()) * 1000) + 1);
    deadline.unref();
  };
  const relay: Relay = new Relay({ ...opt.relay, now: () => (performance.now() - start) / 1000, schedule });
  const wss = new WebSocketServer({
    port: opt.port, host: opt.host, maxPayload: MAX_CLIENT_MSG, perMessageDeflate: false, clientTracking: true,
    verifyClient: (info, done) => (roomOf(info.req.url) === null ? done(false, 400, 'bad room code') : done(true)),
  });
  wss.on('connection', (ws, req) => relay.accept(new WsTransport(ws), { room: roomOf(req.url) ?? undefined }));
  const timer = setInterval(() => relay.update(), opt.tickMs ?? 1000);
  timer.unref();
  const batch = relay.opt.batchInterval > 0 ? setInterval(() => relay.flush(), relay.opt.batchInterval * 1000) : null;
  batch?.unref();
  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      wss.off('error', reject);
      wss.on('error', (e) => relay.opt.log(`server error: ${e.message}`));
      const addr = wss.address();
      resolve({
        relay,
        port: typeof addr === 'object' && addr ? addr.port : opt.port,
        close: () => new Promise<void>((done) => {
          clearInterval(timer);
          if (batch) clearInterval(batch);
          if (deadline) clearTimeout(deadline);
          relay.shutdown();
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => done());
        }),
      });
    });
  });
}

const roomOf = (url: string | undefined) => roomFromPath(new URL(url ?? '/', 'ws://relay').pathname);

class WsTransport implements Transport {
  onOpen: (() => void) | null = null;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  state: TransportState = 'open';
  private notified = false;

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) { this.close('text frame'); return; }
      const buf = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      this.onMessage?.(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    ws.on('close', (code, reason) => this.finish(reason.toString() || `closed (${code})`));
    ws.on('error', (e) => this.finish(`socket error: ${e.message}`));   // e.g. a frame over maxPayload
  }

  send(lane: Lane, data: Uint8Array) {
    if (this.state !== 'open' || this.ws.readyState !== WebSocket.OPEN) return;
    if (lane === 'unreliable' && this.ws.bufferedAmount > UNRELIABLE_BACKLOG) return;
    this.ws.send(data);
  }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    // let the queued error message go out first (close sends after it); terminate if the peer never answers
    try { this.ws.close(1000, truncUtf8(reason, 120)); } catch { this.ws.terminate(); }
    setTimeout(() => this.ws.terminate(), 2000).unref();
    this.finish(reason);
  }

  private finish(reason: string) {
    this.state = 'closed';
    if (this.notified) return;
    this.notified = true;
    this.onClose?.(reason);
  }
}
