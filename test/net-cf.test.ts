import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { WebSocket } from 'ws';
import { NetClient, type NetClientOptions, type NetEvent } from '../src/net/client';
import { decodeMessage, emptyCarState, encodeMessage, ERROR, PROTOCOL_VERSION } from '../src/net/protocol';
import { emptySample } from '../src/net/remote';
import { relayUrl, WebSocketTransport } from '../src/net/websocket';

// The Cloudflare relay (server/cf/worker.ts: the Worker and one Durable Object per room) run locally by wrangler's
// own dev server (workerd through Miniflare; offline, no account), driven in real time by NetClients over
// WebSocketTransport and by raw `ws` sockets. MAX_PLAYERS 3, MIN_LAP_SECS 1 and WEEKEND_SCALE 0.05 (vars, as a
// deployment would set them) so a full room, an accepted lap and a weekend's deadlines fit in a short test.

process.env.WRANGLER_SEND_METRICS = 'false';
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let base = '';
beforeAll(async () => {
  worker = await unstable_startWorker({
    config: 'server/cf/wrangler.jsonc',
    bindings: { MAX_PLAYERS: { type: 'plain_text', value: '3' }, MIN_LAP_SECS: { type: 'plain_text', value: '1' },
      WEEKEND_SCALE: { type: 'plain_text', value: '0.05' } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false, logLevel: 'error', persist: false },
  });
  const u = await worker.url;
  base = `ws://${u.host}`;
}, 60_000);
afterAll(async () => { await worker?.dispose(); });

const now = () => performance.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(5); }
}

// NetClients pumped every 5 ms, each sending a car moving along z at 30 m/s (x = 100 * its index)
function clients() {
  const all: { c: NetClient; events: NetEvent[]; k: number }[] = [];
  const timer = setInterval(() => {
    for (const p of all) {
      p.c.update(now());
      p.events.push(...p.c.takeEvents());
      p.c.sendState({ ...emptyCarState(), x: 100 * p.k, z: 30 * now(), vz: 30, gear: 3 }, now());
    }
  }, 5);
  return {
    add(room: string, name: string, car = 'lcf1', url = relayUrl(base, room), o: Partial<NetClientOptions> = {}) {
      const p = { c: new NetClient(new WebSocketTransport(url), { room, name, car, circuit: 'spa', clock: now, ...o }), events: [] as NetEvent[], k: all.length };
      all.push(p);
      return p;
    },
    stop() { clearInterval(timer); for (const p of all) p.c.close(); },
  };
}

// a raw socket: what it got (decoded), and how it ended
function raw(url: string) {
  const ws = new WebSocket(url);
  const s = { ws, got: [] as ReturnType<typeof decodeMessage>[], closed: null as number | null, open: false, status: 0 };
  ws.on('open', () => { s.open = true; });
  ws.on('message', (d: Buffer) => s.got.push(decodeMessage(new Uint8Array(d))));
  ws.on('close', (code) => { s.closed = code; });
  ws.on('unexpected-response', (_req, res) => { s.status = res.statusCode ?? 0; s.closed = -1; });
  ws.on('error', () => { s.closed ??= -1; });
  return s;
}

describe('Cloudflare relay (local workerd)', () => {
  it('relays roster, car states, contacts, laps and the board between three clients, and leaves', async () => {
    const net = clients();
    try {
      const a = net.add('CF1', 'Ann'), b = net.add('CF1', 'Ben', 'drift'), c = net.add('CF1', 'Cat', 'lcgt3');
      const all = [a, b, c];
      await until(() => all.every((p) => p.c.status === 'joined' && p.c.players.size === 3));
      expect(all.map((p) => p.c.circuit)).toEqual(['spa', 'spa', 'spa']);
      expect(new Set(all.map((p) => p.c.selfId)).size).toBe(3);
      await until(() => all.every((p) => p.c.stats.statesReceived > 40));
      for (const p of all) for (const q of all) {
        if (p === q) continue;
        const s = p.c.sample(q.c.selfId, now(), emptySample())!;
        expect(s.x).toBe(100 * q.k);
        expect(Math.abs(s.z - 30 * now())).toBeLessThan(1);
      }
      expect(a.c.rtt).toBeLessThan(0.1);

      a.c.sendContact({ other: b.c.selfId, at: now(), impulse: { x: 100, y: 0, z: -50 }, point: { x: 1, y: 0.5, z: 2 }, closing: 4 });
      await until(() => b.events.some((e) => e.type === 'contact'));
      const hit = b.events.find((e) => e.type === 'contact') as Extract<NetEvent, { type: 'contact' }>;
      expect(hit.from).toBe(a.c.selfId);
      expect(hit.impulse.x).toBeCloseTo(-100, 3);
      expect(c.events.some((e) => e.type === 'contact')).toBe(false);

      await until(() => a.c.serverTime(now()) > 1.6);   // MIN_LAP_SECS 1: a 1.5 s lap after 0.5 s in the room
      a.c.sendLap({ time: 1.5, sectors: [0.5, 0.5, 0.5], valid: true });
      await until(() => all.every((p) => p.c.board.length === 1));
      expect(c.c.board[0]).toMatchObject({ player: a.c.selfId, name: 'Ann', best: 1.5, laps: 1 });
      expect(b.events.some((e) => e.type === 'lap' && e.player === a.c.selfId)).toBe(true);
      a.c.sendLap({ time: 0.5, sectors: [0.2, 0.2, 0.1], valid: true });   // under MIN_LAP_SECS: refused
      await until(() => a.events.some((e) => e.type === 'error' && e.code === ERROR.lapRejected));

      b.c.close();
      await until(() => a.c.players.size === 2 && c.c.players.size === 2);
      expect(a.events.some((e) => e.type === 'leave' && e.player.id === b.c.selfId)).toBe(true);
    } finally { net.stop(); }
  });

  it('refuses a full room, and keeps two rooms apart', async () => {
    const net = clients();
    try {
      const full = [net.add('CF2', 'P1'), net.add('CF2', 'P2'), net.add('CF2', 'P3')];
      const other = net.add('CF3', 'Solo');
      await until(() => full.every((p) => p.c.status === 'joined') && other.c.status === 'joined');
      const late = net.add('CF2', 'P4');
      await until(() => late.c.status === 'closed');
      expect(late.events.some((e) => e.type === 'error' && e.code === ERROR.roomFull)).toBe(true);
      await sleep(200);
      expect(other.c.players.size).toBe(1);
      expect(other.c.remotes.size).toBe(0);
      expect(other.c.stats.statesReceived).toBe(0);
      for (const p of full) expect(p.c.players.size).toBe(3);
    } finally { net.stop(); }
  });

  it('creates and joins rooms explicitly, hands the host role on, and times the sessions on its clock', async () => {
    const net = clients();
    try {
      const host = net.add('CW1', 'Hal', 'lcf1', undefined, { mode: 'create' });
      await until(() => host.c.status === 'joined');
      const clash = net.add('CW1', 'Dup', 'lcf1', undefined, { mode: 'create' });
      const missing = net.add('CWX', 'Lost', 'lcf1', undefined, { mode: 'join' });
      const guest = net.add('CW1', 'Gus', 'drift', undefined, { mode: 'join' });
      await until(() => clash.c.status === 'closed' && missing.c.status === 'closed' && guest.c.status === 'joined');
      expect(clash.events.some((e) => e.type === 'error' && e.code === ERROR.roomTaken)).toBe(true);
      expect(missing.events.some((e) => e.type === 'error' && e.code === ERROR.noRoom)).toBe(true);
      expect(host.c.isHost).toBe(true);
      expect(guest.c.host).toBe(host.c.selfId);
      // the object the missing room's join reached refused it and holds no room: a create there works
      const later = net.add('CWX', 'New', 'lcf1', undefined, { mode: 'create' });
      await until(() => later.c.status === 'joined');
      expect(later.c.isHost).toBe(true);

      guest.c.setSettings({ raceLaps: 9 });
      await until(() => guest.events.some((e) => e.type === 'error' && e.code === ERROR.notHost));
      host.c.setSettings({ practice: 1, practiceMinutes: 1, qualifying: 'none', raceLaps: 2, weather: 'wet' });
      await until(() => guest.c.settings.raceLaps === 2);
      host.c.startWeekend();
      await until(() => guest.c.session.phase === 'practice');
      const p = guest.c.session;
      expect(p.end! - p.start).toBeCloseTo(3, 6);   // a settings minute is 3 s at WEEKEND_SCALE 0.05
      expect(guest.c.weather.kind).toBe('wet');
      await until(() => guest.c.session.phase === 'race', 6000);   // the object's deadline timer, not a client message
      expect(guest.c.session.start).toBe(p.end);
      expect(guest.c.session.grid).toEqual([host.c.selfId, guest.c.selfId]);
      host.c.skipSession();
      await until(() => guest.c.session.stage === 'results');
      expect(guest.c.standingsFinal).toBe(true);
      await until(() => guest.c.session.phase === 'lobby', 4000);   // the results' 1.5 s
      expect(guest.c.standings.map((s) => s.status)).toEqual(['outOfTime', 'outOfTime']);
      host.c.close();
      await until(() => guest.c.isHost, 3000);   // after the host's grace (0.5 s here)
    } finally { net.stop(); }
  }, 20_000);

  it('refuses a bad room in the address, a hello for another room, text and garbage', async () => {
    for (const path of ['/room/abc', '/room/TOOLONGXX', '/room/', '/elsewhere']) {
      const s = raw(base + path);
      await until(() => s.closed !== null);
      expect(s.open).toBe(false);
      expect(s.status).toBe(path === '/elsewhere' ? 404 : 400);
    }

    const net = clients();
    try {
      const wrong = net.add('CF4', 'Wrong', 'lcf1', relayUrl(base, 'CF5'));
      await until(() => wrong.c.status === 'closed');
      expect(wrong.events.some((e) => e.type === 'error' && e.code === ERROR.badRoom)).toBe(true);
    } finally { net.stop(); }

    const junk = raw(relayUrl(base, 'CF6'));
    await until(() => junk.open);
    junk.ws.send(new Uint8Array([1, 2, 3, 4]));
    await until(() => junk.closed !== null);
    expect(junk.got[0]).toMatchObject({ ok: true, msg: { type: 'error', fatal: true } });

    const big = raw(relayUrl(base, 'CF6'));
    await until(() => big.open);
    big.ws.send(new Uint8Array(5000));
    await until(() => big.closed !== null);
    expect(big.got[0]).toMatchObject({ ok: true, msg: { type: 'error', code: ERROR.tooBig } });

    const text = raw(relayUrl(base, 'CF6'));
    await until(() => text.open);
    text.ws.send('hello');
    await until(() => text.closed !== null);

    const old = raw(relayUrl(base, 'CF6'));
    await until(() => old.open);
    old.ws.send(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, mode: 'either', token: 0, room: 'CF6', name: 'n', car: 'lcf1', circuit: '' }).map((v, i) => (i === 1 ? v + 1 : v)));
    await until(() => old.closed !== null);
    expect(old.got[0]).toMatchObject({ ok: true, msg: { type: 'error', code: ERROR.version } });
  });
});
