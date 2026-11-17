import type { Lane, Transport, TransportState } from './transport';

// ============================================================================
// The client's Transport over a WebSocket (the browser's, or Node's global WebSocket): both lanes share the one
// socket, so in practice everything arrives, in order. The unreliable lane drops a message instead of queueing it
// while the socket is backed up (more than UNRELIABLE_BACKLOG bytes unsent): over TCP a queue of old car states only
// adds latency. Binary frames only; a text frame from the relay closes the connection.
// ============================================================================
export const UNRELIABLE_BACKLOG = 16 * 1024;

// The parts of the WebSocket API this uses (the browser's and Node's both fit).
interface Socket {
  binaryType: string; readonly readyState: number; readonly bufferedAmount: number;
  send(data: Uint8Array): void; close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: ((ev: unknown) => void) | null;
}
type SocketCtor = new (url: string) => Socket;

export class WebSocketTransport implements Transport {
  onOpen: (() => void) | null = null;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  state: TransportState = 'connecting';
  dropped = 0;                     // unreliable messages dropped for backlog
  private ws: Socket;
  private closed = false;

  constructor(url: string, ctor: SocketCtor = (globalThis as unknown as { WebSocket: SocketCtor }).WebSocket) {
    this.ws = new ctor(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => { if (this.state === 'connecting') { this.state = 'open'; this.onOpen?.(); } };
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this.onMessage?.(new Uint8Array(ev.data));
      else this.close('text frame');
    };
    this.ws.onclose = (ev) => this.finish(ev.reason || `socket closed (${ev.code})`);
    this.ws.onerror = () => this.finish('socket error');
  }

  send(lane: Lane, data: Uint8Array) {
    if (this.state !== 'open') return;
    if (lane === 'unreliable' && this.ws.bufferedAmount > UNRELIABLE_BACKLOG) { this.dropped++; return; }
    this.ws.send(data);
  }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    try { this.ws.close(1000, reason.slice(0, 100)); } catch { /* already closing */ }
    this.finish(reason);
  }

  private finish(reason: string) {
    this.state = 'closed';
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}
