#!/usr/bin/env python3
"""Reference client for the RL environment worker (docs/ai-env.md), standard library only.

Starts build/env/worker.mjs (npm run build:env first), does the handshake, runs random actions and prints what
came back. Usage: python3 ai/client.py [num_envs] [steps]
"""
import array, json, os, random, struct, subprocess, sys

HELLO, INIT, READY, RESET, RESET_OK, STEP, STEP_OK, ERROR, CLOSE = 0x01, 0x02, 0x03, 0x10, 0x11, 0x20, 0x21, 0x7E, 0x7F
HEADER = 8
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'env', 'worker.mjs')


def pad8(n):
    return (n + 7) & ~7


def floats(buf, off, n, code):  # array.array of n items of type code ('f' float32, 'd' float64, 'I' uint32) at off
    a = array.array(code)
    a.frombytes(buf[off:off + n * a.itemsize])
    if sys.byteorder != 'little':
        a.byteswap()
    return a


class EnvWorker:
    def __init__(self, path=WORKER):
        self.p = subprocess.Popen(['node', path], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def _read(self, n):
        b = self.p.stdout.read(n)
        if len(b) != n:
            raise EOFError('worker closed its output')
        return b

    def recv(self, want):
        (length,) = struct.unpack('<I', self._read(4))
        payload = self._read(length)
        if payload[0] == ERROR:
            raise RuntimeError('worker: ' + json.loads(payload[HEADER:])['error'])
        if payload[0] != want:
            raise RuntimeError(f'expected message {want}, got {payload[0]}')
        return payload

    def send(self, typ, arg, body=b''):
        self.p.stdin.write(struct.pack('<IB3xI', HEADER + len(body), typ, arg) + body)
        self.p.stdin.flush()

    def send_json(self, typ, value):
        body = json.dumps(value).encode()
        self.send(typ, len(body), body)

    def hello(self):
        return json.loads(self.recv(HELLO)[HEADER:])

    def init(self, num_envs, seed=0, config=None):
        self.send_json(INIT, {'numEnvs': num_envs, 'seed': seed, 'config': config or {}})
        ready = json.loads(self.recv(READY)[HEADER:])
        self.n, self.D, self.F = num_envs, ready['obsSize'], len(ready['infoFields'])
        return ready

    def reset(self, options=None):
        self.send_json(RESET, options or {})
        p = self.recv(RESET_OK)
        n, d, f, _ = struct.unpack_from('<4I', p, HEADER)
        o_obs = HEADER + 16
        return floats(p, o_obs, n * d, 'f'), floats(p, pad8(o_obs + 4 * n * d), n * f, 'd')

    def step(self, actions):  # actions: flat list of 2 floats per env (steer, pedal)
        self.send(STEP, self.n, struct.pack(f'<{2 * self.n}f', *actions))
        p = self.recv(STEP_OK)
        n, d, f, k = struct.unpack_from('<4I', p, HEADER)
        o_obs = HEADER + 16
        o_rew = o_obs + 4 * n * d
        o_term = o_rew + 4 * n
        o_trunc = o_term + n
        o_info = pad8(o_trunc + n)
        o_done = o_info + 8 * n * f
        o_final = pad8(o_done + 4 * k)
        return {
            'obs': floats(p, o_obs, n * d, 'f'), 'reward': floats(p, o_rew, n, 'f'),
            'terminated': list(p[o_term:o_term + n]), 'truncated': list(p[o_trunc:o_trunc + n]),
            'info': floats(p, o_info, n * f, 'd'), 'done': list(floats(p, o_done, k, 'I')),
            'final_obs': floats(p, o_final, k * d, 'f'),
        }

    def close(self):
        self.send(CLOSE, 0)
        self.p.wait()


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    w = EnvWorker()
    hello = w.hello()
    game = hello['game']
    print(f"protocol {hello['protocol']}, game {game['commit'][:9]}{' (dirty)' if game['dirty'] else ''}, "
          f"{len(hello['tracks'])} tracks, cars {' '.join(hello['cars'])}")
    ready = w.init(n, seed=1, config={'reset': {'tracks': ['melbourne', 'monaco'], 'cars': hello['cars']}})
    names = [e['name'] for e in ready['obsSpec']]
    print(f"{n} envs, observation {ready['obsSize']} floats ({names[3]}, {names[4]}, ...)")
    obs, info = w.reset()
    i_speed, i_end = ready['infoFields'].index('speed'), ready['infoFields'].index('end_reason')
    print('start speeds (m/s):', ' '.join(f'{info[k * w.F + i_speed]:.1f}' for k in range(n)))
    rng = random.Random(1)
    total, ended = 0.0, 0
    for s in range(steps):
        r = w.step([v for _ in range(n) for v in (rng.uniform(-0.3, 0.3), rng.uniform(-0.4, 1))])
        total += sum(r['reward'])
        for k in r['done']:
            ended += 1
            print(f"  env {k} ended at step {s}: {ready['endReasons'][int(r['info'][k * w.F + i_end])]}")
    print(f'{steps} steps x {n} envs, total reward {total:.1f}, {ended} episodes ended')
    w.close()


if __name__ == '__main__':
    main()
