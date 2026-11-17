import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import { CARS } from '../src/cars';
import { NET_CARS, NET_CIRCUITS } from '../src/net/ids';
import {
  type CarState, decodeMessage, emptyCarState, encodeBundle, encodeMessage, encodeState, helloVersion, MSG, type NetMessage,
  PROTOCOL_VERSION, seqNewer, STATE_BYTES, type StateMsg, stateValid, timeToWire, unwrapTime,
} from '../src/net/protocol';
import { TRACKS } from '../src/tracks';

// The multiplayer wire format (src/net/protocol.ts, docs/net.md): every message round-trips, car states within
// their quantisation, and nothing malformed gets past the decoder (which faces the internet on the relay).

const state = (o: Partial<CarState> = {}): CarState => {
  const q = { x: 0.1, y: 0.7, z: -0.05, w: 0.7 }, n = Math.hypot(q.x, q.y, q.z, q.w);
  return { ...emptyCarState(), x: -3123.4567, y: 12.345, z: 2876.5432, qx: q.x / n, qy: q.y / n, qz: q.z / n, qw: q.w / n,
    vx: 81.234, vy: -0.42, vz: -30.987, wx: 0.012, wy: 0.734, wz: -0.021, steer: 0.123, throttle: 0.8, brake: 0.05,
    gear: 6, rpm: 11234, flags: 5, epoch: 9, ...o };
};

const board = [{ player: 2, name: 'Zoë', car: 'lcf1', best: 116.548123, sectors: [30.1, 40.2, 46.248123], laps: 3 },
  { player: 0, name: 'Left Early', car: 'drift', best: 158.25, sectors: [null, null, null], laps: 1 }];
const samples: NetMessage[] = [
  { type: 'hello', version: PROTOCOL_VERSION, room: 'AB12', name: 'Max Ü', car: 'lcgt3', circuit: 'monza' },
  { type: 'hello', version: PROTOCOL_VERSION, room: 'Z', name: '', car: 'drift', circuit: '' },
  { type: 'welcome', version: PROTOCOL_VERSION, you: 3, room: 'AB12', circuit: 'monza', serverTime: 1234.5678, maxPlayers: 8, stateHz: 60,
    players: [{ id: 1, name: 'A', car: 'lcf1' }, { id: 3, name: 'Bé', car: 'drift' }], board },
  { type: 'joined', player: { id: 7, name: 'New', car: 'lcgt3' } },
  { type: 'left', id: 7, reason: 1 },
  { type: 'player', player: { id: 0, name: 'Renamed', car: 'lcf1' } },
  { type: 'ping', nonce: 4000000000, clientTime: 98765.4321 },
  { type: 'pong', nonce: 17, clientTime: 1.25, serverTime: 3600.125 },
  { type: 'contact', from: 0, to: 4, timeWire: 123456789, ix: 1500.5, iy: -2, iz: 300.25, px: -120.5, py: 0.5, pz: 2200.75, closing: 12.5 },
  { type: 'lap', player: 0, time: 116.548123, sectors: [30.1, 40.2, 46.248123], valid: true },
  { type: 'lap', player: 5, time: 130.5, sectors: [31, null, null], valid: false },
  { type: 'board', board },
  { type: 'board', board: [] },
  { type: 'restart', player: 0 },
  { type: 'error', code: 2, fatal: true, message: 'room AB12 is full' },
];

describe('protocol', () => {
  it('round-trips every reliable message', () => {
    for (const m of samples) {
      const bytes = encodeMessage(m);
      const d = decodeMessage(bytes);
      expect(d.ok, `${m.type}: ${!d.ok && d.error}`).toBe(true);
      if (!d.ok) continue;
      const got = d.msg as unknown as Record<string, unknown>;
      // floats on the wire are f32 (contact) and microseconds (laps): compare those to their precision
      if (m.type === 'contact') for (const [k, v] of Object.entries(m)) typeof v === 'number' ? expect(got[k]).toBeCloseTo(v, 2) : expect(got[k]).toBe(v);
      else expect(got).toEqual(m);
    }
  });

  it('packs a car state into 42 bytes, within its quantisation', () => {
    const s = state();
    const bytes = encodeState(s, 65535, 4321.98765);
    expect(bytes.length).toBe(STATE_BYTES);
    expect(STATE_BYTES).toBe(42);
    expect(stateValid(bytes)).toBe(true);
    const d = decodeMessage(bytes);
    if (!d.ok || d.msg.type !== 'state') throw new Error('no state');
    const m = d.msg;
    expect(m.seq).toBe(65535);
    expect(unwrapTime(m.timeWire, 4321.9)).toBeCloseTo(4321.98765, 4);
    for (const k of ['x', 'y', 'z'] as const) expect(Math.abs(m[k] - s[k])).toBeLessThanOrEqual(0.0005);
    for (const k of ['vx', 'vy', 'vz'] as const) expect(Math.abs(m[k] - s[k])).toBeLessThanOrEqual(0.005);
    for (const k of ['wx', 'wy', 'wz'] as const) expect(Math.abs(m[k] - s[k])).toBeLessThanOrEqual(0.0005);
    const dot = Math.abs(m.qx * s.qx + m.qy * s.qy + m.qz * s.qz + m.qw * s.qw);
    expect(2 * Math.acos(Math.min(1, dot))).toBeLessThan(1e-4);   // rad: under 0.006 deg
    expect(Math.abs(m.steer - s.steer)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(m.throttle - s.throttle)).toBeLessThanOrEqual(0.5 / 255);
    expect([m.gear, m.rpm, m.flags, m.epoch, m.player]).toEqual([6, 11234, 5, 9, 0]);
  });

  it('bundles relayed states, and rejects a bundle with a bad state in it', () => {
    const a = encodeState(state(), 1, 10), b = encodeState(state({ x: 5, gear: -1 }), 2, 11);
    a[1] = 3; b[1] = 4;
    const bundle = encodeBundle([a, b]);
    expect(bundle.length).toBe(2 + 2 * STATE_BYTES);
    const d = decodeMessage(bundle);
    if (!d.ok || d.msg.type !== 'states') throw new Error('no bundle');
    expect(d.msg.states).toEqual([decodeMessage(a), decodeMessage(b)].map((x) => x.ok && x.msg));
    expect(d.msg.states.map((s) => s.player)).toEqual([3, 4]);
    const broken = bundle.slice(); broken[2 + STATE_BYTES + 38] = 50;   // the second state's gear
    expect(decodeMessage(broken).ok).toBe(false);
    expect(decodeMessage(bundle.subarray(0, bundle.length - 1)).ok).toBe(false);
    expect(decodeMessage(new Uint8Array([MSG.states, 0])).ok).toBe(false);
  });

  it('keeps every orientation to within a hundredth of a degree', () => {
    const rng = new Rng(3);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      let q = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
      if (i < 8) q = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0, 0, 0, -1], [-1, 0, 0, 0], [0.5, 0.5, 0.5, 0.5], [0, -Math.SQRT1_2, 0, Math.SQRT1_2]][i];
      const n = Math.hypot(...q);
      const s = state({ qx: q[0] / n, qy: q[1] / n, qz: q[2] / n, qw: q[3] / n });
      const d = decodeMessage(encodeState(s, 1, 0));
      if (!d.ok || d.msg.type !== 'state') throw new Error(`quaternion ${q} did not decode`);
      const m = d.msg, dot = Math.abs(m.qx * s.qx + m.qy * s.qy + m.qz * s.qz + m.qw * s.qw);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, dot)));
    }
    expect(worst * 180 / Math.PI).toBeLessThan(0.01);
  });

  it('clamps out-of-range and non-finite values instead of making a bad packet', () => {
    const s = state({ x: 1e7, y: Number.NaN, vx: 1e4, wy: -1e3, steer: 9, throttle: 2, brake: -1, gear: 40, rpm: 1e6, qx: Number.NaN });
    const bytes = encodeState(s, 1, -5);
    expect(stateValid(bytes)).toBe(true);
    const d = decodeMessage(bytes);
    if (!d.ok || d.msg.type !== 'state') throw new Error('no state');
    expect(d.msg.x).toBeCloseTo(8388.607, 3);
    expect(d.msg.y).toBe(0);
    expect(d.msg.vx).toBeCloseTo(327.67, 2);
    expect([d.msg.gear, d.msg.rpm, d.msg.throttle, d.msg.brake, d.msg.qw]).toEqual([15, 30000, 1, 0, 1]);
  });

  it('unwraps times and compares sequence numbers across the wrap', () => {
    const wrap = 4294967296 / 1e4;
    for (const t of [0, 1.5, wrap - 0.001, wrap + 0.002, 3 * wrap + 100]) {
      for (const ref of [t - 3, t, t + 3]) expect(unwrapTime(timeToWire(t), ref)).toBeCloseTo(t, 4);
    }
    expect(seqNewer(1, 65535)).toBe(true);
    expect(seqNewer(65535, 1)).toBe(false);
    expect(seqNewer(5, 5)).toBe(false);
    expect(seqNewer(300, 200)).toBe(true);
  });

  it('reads the protocol version of any hello, even one that no longer parses', () => {
    const h = encodeMessage(samples[0]);
    expect(helloVersion(h)).toBe(PROTOCOL_VERSION);
    const other = new Uint8Array([MSG.hello, 2, 0, 99, 99]);
    expect(helloVersion(other)).toBe(2);
    expect(decodeMessage(other)).toEqual({ ok: false, error: 'version' });
    expect(helloVersion(new Uint8Array([MSG.ping, 1, 0]))).toBe(null);
  });

  it('rejects malformed input', () => {
    const bad: [string, Uint8Array][] = [
      ['empty', new Uint8Array(0)],
      ['unknown type', new Uint8Array([0x7f])],
      ['reserved type', new Uint8Array([0x20, 0])],
      ['state truncated', encodeState(state(), 1, 0).subarray(0, 41)],
      ['state trailing', new Uint8Array([...encodeState(state(), 1, 0), 0])],
      ['ping trailing', new Uint8Array([...encodeMessage(samples[6]), 1])],
      ['pong truncated', encodeMessage(samples[7]).subarray(0, 12)],
      ['bad utf-8 name', new Uint8Array([MSG.hello, PROTOCOL_VERSION, 0, 1, 65, 2, 0xc3, 0x28, 4, 108, 99, 102, 49, 0])],
      ['lower-case room', new Uint8Array([MSG.hello, PROTOCOL_VERSION, 0, 1, 97, 1, 65, 4, 108, 99, 102, 49, 0])],
      ['car id with a dot', new Uint8Array([MSG.hello, PROTOCOL_VERSION, 0, 1, 65, 1, 65, 4, 108, 46, 102, 49, 0])],
      ['name too long', new Uint8Array([MSG.hello, PROTOCOL_VERSION, 0, 1, 65, 49, ...new Array(49).fill(65), 4, 108, 99, 102, 49, 0])],
      ['left reason', new Uint8Array([MSG.left, 3, 9])],
      ['error flag', new Uint8Array([MSG.error, 1, 2, 0])],
      ['lap flag', new Uint8Array([MSG.lap, 0, 1, 0, 0, 0, ...new Array(12).fill(255), 2])],
      ['lap with no time', new Uint8Array([MSG.lap, 0, 255, 255, 255, 255, ...new Array(12).fill(255), 0])],
      ['board too long', new Uint8Array([MSG.board, 200])],
    ];
    const ping = encodeMessage(samples[6]); new DataView(ping.buffer).setFloat64(5, Number.NaN, true);
    bad.push(['NaN time', ping]);
    const contact = encodeMessage(samples[8]); new DataView(contact.buffer).setFloat32(7, 1e9, true);
    bad.push(['huge impulse', contact]);
    const quat = encodeState(state(), 1, 0); quat[21] = 0xff; quat[22] = 0x7f; quat[17] = 0xff; quat[18] = 0x7f;
    bad.push(['impossible quaternion', quat]);
    const gear = encodeState(state(), 1, 0); gear[38] = 100;
    bad.push(['gear', gear]);
    const flags = encodeState(state(), 1, 0); flags[41] |= 8;
    bad.push(['reserved flag', flags]);
    for (const [why, bytes] of bad) {
      const d = decodeMessage(bytes);
      expect(d.ok, why).toBe(false);
      if (bytes[0] === MSG.state) expect(stateValid(bytes), why).toBe(false);
    }
  });

  it('survives fuzzing: random bytes, mutations and truncations never throw, and what decodes re-encodes', () => {
    const rng = new Rng(77);
    const seeds = [...samples.map(encodeMessage), encodeState(state(), 9, 77), encodeBundle([encodeState(state(), 1, 2), encodeState(state(), 2, 3)])];
    let decoded = 0, tried = 0;
    const check = (bytes: Uint8Array) => {
      tried++;
      let d: ReturnType<typeof decodeMessage>;
      expect(() => { d = decodeMessage(bytes); }).not.toThrow();
      expect(() => stateValid(bytes)).not.toThrow();
      expect(() => helloVersion(bytes)).not.toThrow();
      if (!d!.ok) return;
      decoded++;
      // anything accepted is a well-formed message: it encodes again, and that decodes to the same message
      const again = decodeMessage(encodeMessage(d!.msg));
      expect(again.ok).toBe(true);
      if (!again.ok || d!.msg.type === 'contact') return;
      // a quaternion with two components of nearly the same size can drop the other one when packed again
      const sameState = (a: StateMsg, b: StateMsg) => {
        expect(Math.abs(a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw)).toBeGreaterThan(1 - 1e-8);
        expect({ ...b, qx: 0, qy: 0, qz: 0, qw: 0 }).toEqual({ ...a, qx: 0, qy: 0, qz: 0, qw: 0 });
      };
      const m = d!.msg, n = again.msg;
      if (m.type === 'state' && n.type === 'state') sameState(m, n);
      else if (m.type === 'states' && n.type === 'states') { expect(n.states.length).toBe(m.states.length); m.states.forEach((s, k) => sameState(s, n.states[k])); }
      else expect(n).toEqual(m);
    };
    for (let i = 0; i < 10000; i++) {
      const n = Math.floor(rng.next() ** 2 * 300);
      const b = new Uint8Array(n);
      for (let k = 0; k < n; k++) b[k] = rng.u32() & 255;
      if (n && rng.next() < 0.7) b[0] = rng.pick(Object.values(MSG));   // a valid type, to reach the bodies
      check(b);
    }
    for (const seed of seeds) {
      for (let cut = 0; cut <= seed.length; cut++) check(seed.subarray(0, cut));
      for (let i = 0; i < 1500; i++) {
        const b = seed.slice();
        const flips = 1 + Math.floor(rng.next() * 4);
        for (let k = 0; k < flips; k++) b[Math.floor(rng.next() * b.length)] = rng.u32() & 255;
        check(rng.next() < 0.1 ? new Uint8Array([...b, rng.u32() & 255]) : b);
      }
    }
    expect(tried).toBeGreaterThan(30000);
    expect(decoded).toBeGreaterThan(500);   // the mutations reach the decoders' range checks, not just the length checks
  });
});

describe('ids and bundling', () => {
  it('lists every car and circuit the game has', () => {
    expect([...NET_CARS].sort()).toEqual(Object.keys(CARS).sort());
    expect([...NET_CIRCUITS].sort()).toEqual(Object.keys(TRACKS).sort());
  });

  it('keeps the relay and ws out of the site: nothing in src/ imports them', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js)$/.test(f)) files.push(p);
      }
    };
    walk('src');
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/from ['"](ws|node:[a-z_]+|\.\.\/(\.\.\/)?server\/[^'"]*)['"]/);
    }
  });
});
