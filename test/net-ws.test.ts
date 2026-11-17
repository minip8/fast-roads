import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { NetClient } from '../src/net/client';
import { decodeMessage, emptyCarState, encodeMessage, ERROR, PROTOCOL_VERSION } from '../src/net/protocol';
import { emptySample } from '../src/net/remote';
import { relayUrl, WebSocketTransport } from '../src/net/websocket';
import { listen, type RelayServer } from '../server/ws';

// The relay's WebSocket entry point (server/ws.ts, what `npm run server` starts) on an ephemeral port, in real time:
// NetClients over WebSocketTransport (Node's global WebSocket, as the browser's), and raw `ws` sockets sending
// what a client never would.

let server: RelayServer;
let url = '';
beforeAll(async () => {
  server = await listen({ port: 0, host: '127.0.0.1', tickMs: 100, relay: { helloTimeout: 1 } });
  url = `ws://127.0.0.1:${server.port}`;
});
afterAll(async () => { await server?.close(); });

const now = () => performance.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(5); }
}

// a raw socket: what it got (decoded), and how it was closed
function raw(path = '') {
  const ws = new WebSocket(url + path);
  const got: ReturnType<typeof decodeMessage>[] = [];
  const s = { ws, got, closed: null as number | null, open: false };
  ws.on('open', () => { s.open = true; });
  ws.on('message', (d: Buffer) => got.push(decodeMessage(new Uint8Array(d))));
  ws.on('close', (code) => { s.closed = code; });
  ws.on('error', () => {});
  return s;
}

describe('WebSocket relay', () => {
  it('joins two clients and relays their cars, roster and laps', async () => {
    const mk = (name: string, car: string) => new NetClient(new WebSocketTransport(url), { room: 'WS1', name, car, circuit: 'spa', clock: now });
    const a = mk('Ann', 'lcf1'), b = mk('Ben', 'drift');
    const timer = setInterval(() => {
      for (const [k, c] of [a, b].entries()) {
        c.update(now());
        c.sendState({ ...emptyCarState(), x: 100 * k, z: 30 * now(), vz: 30, gear: 3 }, now());
      }
    }, 5);
    try {
      await until(() => a.status === 'joined' && b.status === 'joined' && a.players.size === 2 && b.players.size === 2);
      expect(a.circuit).toBe('spa');
      await until(() => a.stats.statesReceived > 20 && b.stats.statesReceived > 20);
      const s = a.sample(b.selfId, now(), emptySample())!;
      expect(s.x).toBe(100);
      expect(Math.abs(s.z - 30 * now())).toBeLessThan(1);   // real time on one machine: a few ms of error
      expect(a.rtt).toBeLessThan(0.1);
      // a lap longer than the client has been in the room: refused, and the client hears why
      a.sendLap({ time: 41, sectors: [10, 15, 16], valid: true });
      await until(() => a.takeEvents().some((e) => e.type === 'error' && e.code === ERROR.lapRejected));
      b.close();
      await until(() => a.players.size === 1);
    } finally {
      clearInterval(timer);
      a.close(); b.close();
    }
  });

  it('takes the room in the address (refusing a bad one at the handshake and a hello for another room)', async () => {
    const bad = raw('/room/abc');
    let status = 0;
    bad.ws.on('unexpected-response', (_req, res) => { status = res.statusCode ?? 0; bad.closed = -1; });
    await until(() => bad.closed !== null);
    expect(bad.open).toBe(false);
    expect(status).toBe(400);

    const mk = (room: string, at: string) => new NetClient(new WebSocketTransport(relayUrl(url, at)), { room, name: 'Pat', car: 'lcf1', clock: now });
    const ok = mk('WS2', 'WS2'), wrong = mk('WS2', 'WS3');
    const timer = setInterval(() => { ok.update(now()); wrong.update(now()); }, 5);
    try {
      await until(() => ok.status === 'joined' && wrong.status === 'closed');
      expect(wrong.takeEvents().some((e) => e.type === 'error' && e.code === ERROR.badRoom)).toBe(true);
    } finally {
      clearInterval(timer);
      ok.close(); wrong.close();
    }
  });

  it('closes sockets that send text, oversized frames, garbage or another version, or nothing', async () => {
    const text = raw();
    await until(() => text.open);
    text.ws.send('hello');
    await until(() => text.closed !== null);

    const big = raw();
    await until(() => big.open);
    big.ws.send(new Uint8Array(5000));
    await until(() => big.closed !== null);
    expect(big.closed).toBe(1009);   // ws's own maxPayload check: message too big

    const junk = raw();
    await until(() => junk.open);
    junk.ws.send(new Uint8Array([1, 2, 3, 4]));
    await until(() => junk.closed !== null);
    expect(junk.got[0]).toMatchObject({ ok: true, msg: { type: 'error', fatal: true } });

    const old = raw();
    await until(() => old.open);
    old.ws.send(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, room: 'X', name: 'n', car: 'lcf1', circuit: '' }).map((v, i) => (i === 1 ? v + 1 : v)));
    await until(() => old.closed !== null);
    expect(old.got[0]).toMatchObject({ ok: true, msg: { type: 'error', code: ERROR.version } });

    const quiet = raw();
    await until(() => quiet.open);
    await until(() => quiet.closed !== null, 3000);   // helloTimeout 1 s here
    expect(quiet.got[0]).toMatchObject({ ok: true, msg: { type: 'error', code: ERROR.idle } });
    await until(() => server.relay.connectionCount === 0);
  });
});
