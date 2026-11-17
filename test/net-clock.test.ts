import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/net/clock';
import { type LinkConditions, LoopbackNet } from '../src/net/loopback';
import { decodeMessage, encodeMessage } from '../src/net/protocol';

// The client's estimate of the relay clock (src/net/clock.ts) over the emulated link: a relay whose clock is
// OFFSET s ahead of the client's answers pings; the estimate is compared with the truth.

const OFFSET = 1234.5678;

function run(up: LinkConditions, down: LinkConditions, seconds: number, seed = 5) {
  const net = new LoopbackNet(seed);
  const { client, server } = net.pair(up, down);
  server.onMessage = (data) => {
    const d = decodeMessage(data);
    if (d.ok && d.msg.type === 'ping') server.send('reliable', encodeMessage({ type: 'pong', nonce: d.msg.nonce, clientTime: d.msg.clientTime, serverTime: net.now + OFFSET }));
  };
  const clock = new ClockSync();
  const sent = new Map<number, number>();
  client.onMessage = (data) => {
    const d = decodeMessage(data);
    if (d.ok && d.msg.type === 'pong') clock.sample(d.msg.serverTime, sent.get(d.msg.nonce)!, net.now);
  };
  let nonce = 0, last = -Infinity, backwards = 0;
  const errors: number[] = [];
  for (let t = 0; t <= seconds; t += 1 / 120) {
    net.advance(t);
    if (client.state === 'open' && (nonce < 6 ? nonce * 0.5 : 3 + (nonce - 6) * 2) <= t) {   // as NetClient: 0.5 s, then 2 s
      sent.set(++nonce, t);
      client.send('reliable', encodeMessage({ type: 'ping', nonce, clientTime: t }));
    }
    if (!clock.synced) continue;
    const est = clock.serverTime(t);
    if (est < last) backwards++;
    last = est;
    if (t > 5) errors.push(Math.abs(est - (t + OFFSET)));
  }
  return { clock, backwards, max: Math.max(...errors), mean: errors.reduce((a, b) => a + b, 0) / errors.length };
}

const link = (latency: number, jitter: number): LinkConditions => ({ latency, jitter, loss: 0, duplicate: 0 });

describe('clock sync', () => {
  it('finds the relay clock to a few milliseconds on a jittery symmetric link, and never runs backwards', () => {
    for (const [lat, jit] of [[0.025, 0.01], [0.05, 0.02], [0.1, 0.04]]) {
      const r = run(link(lat, jit), link(lat, jit), 30);
      // the offset error is half the difference of the two directions' delays in the quickest exchange
      expect(r.max, `${lat * 1000} ms`).toBeLessThan(jit / 2 + 0.002);
      expect(r.backwards).toBe(0);
      expect(r.clock.rtt).toBeGreaterThan(2 * lat);
      expect(r.clock.rtt).toBeLessThan(2 * (lat + jit));
      expect(r.clock.jitter).toBeGreaterThan(0);
      expect(r.clock.jitter).toBeLessThan(jit);
      expect(r.clock.minRtt).toBeGreaterThanOrEqual(2 * lat);
    }
  });

  it('is off by half the difference on an asymmetric link (which no ping can see)', () => {
    const r = run(link(0.03, 0.005), link(0.07, 0.005), 30);
    expect(Math.abs(r.mean - 0.02)).toBeLessThan(0.004);
  });

  it('slews small corrections and snaps big ones', () => {
    const c = new ClockSync();
    c.sample(100, 0, 0.1);                 // offset 99.95
    expect(c.serverTime(0.1)).toBeCloseTo(100.05, 6);
    c.sample(100.15, 0.2, 0.3);            // rtt 0.1 again, offset 99.9: 50 ms off, slewed at 5% of elapsed time
    expect(c.offset).toBeCloseTo(99.95, 6);
    expect(c.serverTime(0.3 + 0.5)).toBeCloseTo(0.8 + 99.95 - 0.025, 6);
    expect(c.serverTime(3)).toBeCloseTo(3 + 99.9, 6);
    c.sample(600, 3, 3.1);                 // the relay restarted far off: snap
    expect(c.serverTime(3.1)).toBeCloseTo(600 + 0.05, 6);
  });
});
