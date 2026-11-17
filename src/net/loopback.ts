import { Rng } from '../ai/rng';
import type { Lane, Transport, TransportState } from './transport';

// ============================================================================
// An in-process network for tests: pairs of Transports joined by emulated links, on a manual clock (no timers) and
// a seeded rng, so a run is the same every time. Each direction of a link has its own conditions:
//   latency   one-way delay (s)
//   jitter    extra delay, uniform in [0, jitter] (s), drawn per message; on the unreliable lane it reorders
//             messages, on the reliable lane deliveries keep their order (as TCP: a late one holds back the rest)
//   loss      share of unreliable messages dropped
//   duplicate share of unreliable messages delivered twice (the copy with its own jitter)
// The reliable lane never loses, duplicates or reorders. Nothing is delivered until advance() reaches its time;
// deliveries due at the same time go in the order they were sent.
// ============================================================================
export interface LinkConditions { latency: number; jitter: number; loss: number; duplicate: number }
export const PERFECT_LINK: LinkConditions = { latency: 0, jitter: 0, loss: 0, duplicate: 0 };

export interface LinkStats { messages: number; bytes: number; unreliableMessages: number; unreliableBytes: number; dropped: number }
const emptyStats = (): LinkStats => ({ messages: 0, bytes: 0, unreliableMessages: 0, unreliableBytes: 0, dropped: 0 });

interface Pending { at: number; order: number; run: () => void }

export class LoopbackNet {
  now = 0;
  private queue: Pending[] = [];
  private order = 0;
  readonly rng: Rng;
  constructor(seed = 1) { this.rng = new Rng(seed); }

  // A new connection: `client` opens after the up link's latency (onOpen); `server` is open at once (hand it to
  // the relay's accept()). up: client -> server, down: server -> client.
  pair(up: LinkConditions = PERFECT_LINK, down: LinkConditions = up): LoopbackPair {
    const p = new LoopbackPair(this, { ...up }, { ...down });
    this.schedule(this.now + up.latency, () => p.client.opened());
    return p;
  }

  // Runs every delivery due by `t` (in time order) and leaves the clock at t.
  advance(t: number) {
    for (;;) {
      let k = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i];
        if (e.at <= t && (k < 0 || e.at < this.queue[k].at || (e.at === this.queue[k].at && e.order < this.queue[k].order))) k = i;
      }
      if (k < 0) break;
      const [e] = this.queue.splice(k, 1);
      this.now = Math.max(this.now, e.at);
      e.run();
    }
    this.now = Math.max(this.now, t);
  }

  schedule(at: number, run: () => void) { this.queue.push({ at, order: this.order++, run }); }
  get pending() { return this.queue.length; }
}

export class LoopbackPair {
  readonly client: LoopbackEnd;
  readonly server: LoopbackEnd;
  down = false;                    // a dead link: everything vanishes both ways, and nobody is told
  constructor(readonly net: LoopbackNet, public up: LinkConditions, public downLink: LinkConditions) {
    this.client = new LoopbackEnd(this, 'connecting');
    this.server = new LoopbackEnd(this, 'open');
    this.client.peer = this.server; this.server.peer = this.client;
  }
  conditions(from: LoopbackEnd) { return from === this.client ? this.up : this.downLink; }
}

export class LoopbackEnd implements Transport {
  onOpen: (() => void) | null = null;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  peer!: LoopbackEnd;
  readonly sent = emptyStats();    // what this end sent (counted before loss)
  private lastReliable = 0;        // delivery time of the last reliable message (keeps them in order)
  private closeNotified = false;
  constructor(private readonly pair: LoopbackPair, public state: TransportState) {}

  opened() {
    if (this.state !== 'connecting') return;
    this.state = 'open';
    this.onOpen?.();
  }

  send(lane: Lane, data: Uint8Array) {
    if (this.state !== 'open') return;
    const net = this.pair.net, c = this.pair.conditions(this), s = this.sent;
    s.messages++; s.bytes += data.length;
    if (lane === 'unreliable') { s.unreliableMessages++; s.unreliableBytes += data.length; }
    const copy = data.slice();
    const deliver = () => {
      if (this.pair.down || this.peer.state !== 'open') return;
      this.peer.onMessage?.(copy);
    };
    if (lane === 'reliable') {
      const at = Math.max(this.lastReliable, net.now + c.latency + net.rng.next() * c.jitter);
      this.lastReliable = at;
      net.schedule(at, deliver);
      return;
    }
    if (net.rng.next() < c.loss) { s.dropped++; return; }
    net.schedule(net.now + c.latency + net.rng.next() * c.jitter, deliver);
    if (net.rng.next() < c.duplicate) net.schedule(net.now + c.latency + net.rng.next() * c.jitter, deliver);
  }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const net = this.pair.net, c = this.pair.conditions(this);
    net.schedule(net.now, () => this.notifyClose(reason));
    // the other end hears of it after the reliable lane's messages already on their way (as a TCP FIN)
    if (!this.pair.down) net.schedule(Math.max(this.lastReliable, net.now + c.latency), () => this.peer.remoteClosed(reason));
  }

  private remoteClosed(reason: string) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.notifyClose(reason);
  }
  private notifyClose(reason: string) {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onClose?.(reason);
  }
}
