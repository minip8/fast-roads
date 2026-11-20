"""A pool of RL environment worker processes (build/env/worker.mjs, protocol in docs/ai-env.md) as one batch.

Each worker hosts `envs_per_worker` environments; global env index g = worker * envs_per_worker + k. `step` sends
every worker its actions before reading any reply, so the workers compute in parallel. Automatic resets are the
worker's: an env whose episode ended returns the first observation of its next episode, with its final observation
in `final_obs` (rows in `done_idx` order), as Gymnasium's vector environments do.
"""
from __future__ import annotations

import collections
import json
import os
import struct
import subprocess
import sys
import threading
import weakref
from dataclasses import dataclass

import numpy as np

HELLO, INIT, READY, RESET, RESET_OK, STEP, STEP_OK, ERROR, CLOSE = 0x01, 0x02, 0x03, 0x10, 0x11, 0x20, 0x21, 0x7E, 0x7F
HEADER = 8
SEED_STRIDE = 100003   # worker k is INITed with seed + k * SEED_STRIDE, so env seeds never overlap between workers
WORKER = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'build', 'env', 'worker.mjs'))
_HDR = struct.Struct('<IB3xI')   # length prefix + payload header (type, 3 zeros, arg)
_LEN = struct.Struct('<I')
_DIMS = struct.Struct('<4I')


def pad8(n: int) -> int:
    return (n + 7) & ~7


class EnvPoolError(RuntimeError):
    """A worker died, replied ERROR or broke the protocol. The message includes its last stderr lines.
    `fatal` is False only for an ERROR reply (the worker carries on, and so does the pool); otherwise the pool has
    been closed."""

    def __init__(self, message: str, fatal: bool = True):
        super().__init__(message)
        self.fatal = fatal


@dataclass
class StepResult:
    obs: np.ndarray         # float32 [N, D]; for an env whose episode ended, the first obs of its NEW episode
    reward: np.ndarray      # float32 [N]
    terminated: np.ndarray  # bool [N]
    truncated: np.ndarray   # bool [N]
    info: np.ndarray        # float64 [N, F] (for an ended episode: of its last step)
    done_idx: np.ndarray    # int64 [K] global env indices whose episode ended, ascending
    final_obs: np.ndarray   # float32 [K, D] their final observations, in done_idx order


class _Worker:
    """One node process: framed binary I/O over unbuffered pipes, stderr kept in a bounded buffer by a thread."""

    def __init__(self, index: int, node: str, path: str, stderr_lines: int = 40):
        self.index = index
        self.proc = subprocess.Popen([node, path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0)
        self.log: collections.deque[str] = collections.deque(maxlen=stderr_lines)
        self.buf = bytearray(1 << 16)   # reused for every reply; callers copy out of it
        self._lenbuf = bytearray(4)
        self._thread = threading.Thread(target=self._drain_stderr, name=f'envpool-stderr-{index}', daemon=True)
        self._thread.start()

    def _drain_stderr(self) -> None:
        try:
            for line in iter(self.proc.stderr.readline, b''):
                self.log.append(line.decode('utf-8', 'replace').rstrip())
        except (OSError, ValueError):
            pass

    def error(self, what: str, fatal: bool = True, dying: bool = False) -> EnvPoolError:
        if dying:   # its output closed: give it a moment to exit and the reader to collect its last words
            try:
                self.proc.wait(1.0)
            except subprocess.TimeoutExpired:
                pass
        code = self.proc.poll()
        if code is not None:
            self._thread.join(1.0)
        state = 'running' if code is None else f'exited with status {code}'
        tail = '\n'.join(f'    {l}' for l in self.log) or '    (nothing)'
        return EnvPoolError(f'env worker {self.index} (pid {self.proc.pid}, {state}): {what}\n'
                            f'  last stderr lines:\n{tail}', fatal)

    def send(self, typ: int, arg: int, body: bytes = b'') -> None:
        data = memoryview(_HDR.pack(HEADER + len(body), typ, arg) + body)
        try:
            while data:
                n = self.proc.stdin.write(data)
                data = data[n:]
        except (BrokenPipeError, OSError, ValueError) as e:
            raise self.error(f'could not write to the worker ({e.__class__.__name__})', dying=True) from None

    def send_json(self, typ: int, value) -> None:
        body = json.dumps(value).encode()
        self.send(typ, len(body), body)

    def _read_into(self, view: memoryview) -> None:
        out = self.proc.stdout
        got, n = 0, len(view)
        while got < n:
            k = out.readinto(view[got:])
            if not k:
                raise self.error('the worker closed its output (died?)', dying=True)
            got += k

    def recv(self, want: int) -> memoryview:
        """The next payload (a view of self.buf, valid until the next recv). ERROR replies raise."""
        self._read_into(memoryview(self._lenbuf))
        (length,) = _LEN.unpack(self._lenbuf)
        if length < HEADER:
            raise self.error(f'malformed frame (length {length})')
        if length > len(self.buf):
            self.buf = bytearray(max(length, 2 * len(self.buf)))
        p = memoryview(self.buf)[:length]
        self._read_into(p)
        if p[0] == ERROR:
            raise self.error('ERROR reply: ' + json.loads(bytes(p[HEADER:]))['error'], fatal=False)
        if p[0] != want:
            raise self.error(f'expected message 0x{want:02x}, got 0x{p[0]:02x}')
        return p

    def recv_json(self, want: int) -> dict:
        return json.loads(bytes(self.recv(want)[HEADER:]))


def _shutdown(workers: list[_Worker], timeout: float = 5.0) -> None:
    """CLOSE every worker, wait, kill stragglers, reap them. Safe to call on dead or half-started workers."""
    for w in workers:
        if w.proc.poll() is None:
            try:
                w.proc.stdin.write(_HDR.pack(HEADER, CLOSE, 0))
            except (OSError, ValueError):
                pass
        try:
            w.proc.stdin.close()
        except (OSError, ValueError):
            pass
    for w in workers:
        try:
            w.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            w.proc.kill()
            w.proc.wait()
        for f in (w.proc.stdout, w.proc.stderr):
            try:
                f.close()
            except (OSError, ValueError):
                pass
    workers.clear()


class EnvPool:
    def __init__(self, num_workers: int, envs_per_worker: int, config: dict | None = None, seed: int = 0,
                 worker_path: str | None = None, node: str = 'node'):
        if num_workers < 1 or envs_per_worker < 1:
            raise ValueError('num_workers and envs_per_worker must be at least 1')
        self.num_workers, self.envs_per_worker = num_workers, envs_per_worker
        self.num_envs = num_workers * envs_per_worker
        self.seed = seed
        path = worker_path or WORKER
        if not os.path.exists(path):
            raise FileNotFoundError(f'{path} not found: run `npm run build:env` in the repository root')
        self._workers: list[_Worker] = []
        # runs on close(), garbage collection and interpreter exit; holds the list, never self
        self._finalizer = weakref.finalize(self, _shutdown, self._workers)
        self._pending = False
        try:
            for k in range(num_workers):
                self._workers.append(_Worker(k, node, path))
            hellos = [w.recv_json(HELLO) for w in self._workers]
            for k, w in enumerate(self._workers):
                w.send_json(INIT, {'numEnvs': envs_per_worker, 'seed': seed + k * SEED_STRIDE, 'config': config or {}})
            readies = [w.recv_json(READY) for w in self._workers]
        except BaseException:
            self.close()
            raise
        self.hello, self.ready = hellos[0], readies[0]
        for k in range(1, num_workers):
            for key, a, b in (('protocol', hellos[0]['protocol'], hellos[k]['protocol']),
                              ('game.commit', hellos[0]['game']['commit'], hellos[k]['game']['commit']),
                              ('obsSize', readies[0]['obsSize'], readies[k]['obsSize']),
                              ('obsVersion', readies[0]['obsVersion'], readies[k]['obsVersion'])):
                if a != b:
                    self.close()
                    raise EnvPoolError(f'worker {k} reports {key} {b!r}, worker 0 {a!r}')
        if self.hello['protocol'] != 1:
            self.close()
            raise EnvPoolError(f"unsupported protocol {self.hello['protocol']} (this client speaks 1)")
        if self.hello['game'].get('dirty'):
            print(f"envpool: warning: the worker was built from a dirty tree (commit {self.hello['game']['commit'][:9]})",
                  file=sys.stderr)
        self.config = self.ready['config']
        self.obs_dim: int = self.ready['obsSize']
        self.info_fields: list[str] = list(self.ready['infoFields'])
        self.info_dim = len(self.info_fields)
        self.info_index = {n: i for i, n in enumerate(self.info_fields)}
        self.obs_spec: list[dict] = self.ready['obsSpec']
        self.obs_index = {e['name']: e['index'] for e in self.obs_spec}
        self.tracks: list[str] = list(self.hello['tracks'])
        self.cars: list[str] = list(self.hello['cars'])
        self.end_reasons: list[str] = list(self.ready['endReasons'])

    # -- lifecycle

    @property
    def closed(self) -> bool:
        return not self._finalizer.alive

    @property
    def pids(self) -> list[int]:
        return [w.proc.pid for w in self._workers]

    def close(self) -> None:
        self._finalizer()   # idempotent: runs _shutdown once

    def __enter__(self) -> EnvPool:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _check_open(self) -> None:
        if self.closed:
            raise EnvPoolError('the pool is closed')

    def _fail(self, e: EnvPoolError) -> EnvPoolError:
        """A worker died or broke the protocol: the pool is out of step, so shut it all down."""
        self.close()
        return e

    # -- environment

    def reset(self, options: dict | list | None = None) -> tuple[np.ndarray, np.ndarray]:
        """Reset every env. A dict applies to all (its `seed`, if any, gives global env g seed + g); a list of
        num_envs dicts/None, one per env. Returns obs [N, D] float32 and info [N, F] float64."""
        self._check_open()
        if self._pending:
            raise EnvPoolError('reset while a step_async is waiting for step_wait')
        E = self.envs_per_worker
        if options is None or isinstance(options, dict):
            per = []
            for k in range(self.num_workers):
                o = dict(options or {})
                if o.get('seed') is not None:
                    o['seed'] = int(o['seed']) + k * E
                per.append(o)
        else:
            options = list(options)
            if len(options) != self.num_envs:
                raise ValueError(f'reset options: a list of {self.num_envs} (one per env), got {len(options)}')
            per = [options[k * E:(k + 1) * E] for k in range(self.num_workers)]
        obs = np.empty((self.num_envs, self.obs_dim), np.float32)
        info = np.empty((self.num_envs, self.info_dim), np.float64)
        try:
            for w, o in zip(self._workers, per):
                w.send_json(RESET, o)
            first_error = None
            for k, w in enumerate(self._workers):
                try:
                    p = w.recv(RESET_OK)
                except EnvPoolError as e:
                    if e.fatal:
                        raise
                    first_error = first_error or e   # the worker carries on: read the others' replies first
                    continue
                n, d, f, _ = _DIMS.unpack_from(p, HEADER)
                self._check_dims(w, n, d, f)
                o_obs = HEADER + 16
                obs[k * E:(k + 1) * E] = np.frombuffer(p, np.float32, n * d, o_obs).reshape(n, d)
                info[k * E:(k + 1) * E] = np.frombuffer(p, np.float64, n * f, pad8(o_obs + 4 * n * d)).reshape(n, f)
            if first_error:
                raise first_error
        except EnvPoolError as e:
            if e.fatal:
                raise self._fail(e) from None
            raise
        return obs, info

    def _check_dims(self, w: _Worker, n: int, d: int, f: int) -> None:
        if (n, d, f) != (self.envs_per_worker, self.obs_dim, self.info_dim):
            raise w.error(f'reply for N={n}, D={d}, F={f}; expected {self.envs_per_worker}, {self.obs_dim}, {self.info_dim}')

    def step_async(self, actions) -> None:
        """Send each worker its actions (float32 [N, 2]; a NaN in a row makes the autopilot drive that env)."""
        self._check_open()
        if self._pending:
            raise EnvPoolError('step_async called twice without step_wait')
        a = np.ascontiguousarray(actions, dtype='<f4')
        if a.shape != (self.num_envs, 2):
            a = a.reshape(self.num_envs, 2)
        E = self.envs_per_worker
        try:
            for k, w in enumerate(self._workers):
                w.send(STEP, E, a[k * E:(k + 1) * E].tobytes())
        except EnvPoolError as e:
            raise self._fail(e) from None
        self._pending = True

    def step_wait(self) -> StepResult:
        self._check_open()
        if not self._pending:
            raise EnvPoolError('step_wait without step_async')
        self._pending = False
        N, D, F, E = self.num_envs, self.obs_dim, self.info_dim, self.envs_per_worker
        obs = np.empty((N, D), np.float32)
        reward = np.empty(N, np.float32)
        terminated = np.empty(N, bool)
        truncated = np.empty(N, bool)
        info = np.empty((N, F), np.float64)
        done_parts: list[np.ndarray] = []
        final_parts: list[np.ndarray] = []
        first_error = None
        try:
            for k, w in enumerate(self._workers):
                try:
                    p = w.recv(STEP_OK)
                except EnvPoolError as e:
                    if e.fatal:
                        raise
                    first_error = first_error or e
                    continue
                n, d, f, K = _DIMS.unpack_from(p, HEADER)
                self._check_dims(w, n, d, f)
                sl = slice(k * E, (k + 1) * E)
                o_obs = HEADER + 16
                o_rew = o_obs + 4 * n * d
                o_term = o_rew + 4 * n
                o_trunc = o_term + n
                o_info = pad8(o_trunc + n)
                o_done = o_info + 8 * n * f
                o_final = pad8(o_done + 4 * K)
                if len(p) != o_final + 4 * K * d:
                    raise w.error(f'STEP_OK of {len(p)} bytes, expected {o_final + 4 * K * d}')
                obs[sl] = np.frombuffer(p, np.float32, n * d, o_obs).reshape(n, d)
                reward[sl] = np.frombuffer(p, np.float32, n, o_rew)
                terminated[sl] = np.frombuffer(p, np.uint8, n, o_term)
                truncated[sl] = np.frombuffer(p, np.uint8, n, o_trunc)
                info[sl] = np.frombuffer(p, np.float64, n * f, o_info).reshape(n, f)
                if K:
                    done_parts.append(np.frombuffer(p, np.uint32, K, o_done).astype(np.int64) + k * E)
                    final_parts.append(np.frombuffer(p, np.float32, K * d, o_final).reshape(K, d).copy())
            if first_error:
                raise first_error
        except EnvPoolError as e:
            if e.fatal:
                raise self._fail(e) from None
            raise
        if done_parts:
            done_idx, final_obs = np.concatenate(done_parts), np.concatenate(final_parts)
        else:
            done_idx, final_obs = np.empty(0, np.int64), np.empty((0, D), np.float32)
        return StepResult(obs, reward, terminated, truncated, info, done_idx, final_obs)

    def step(self, actions) -> StepResult:
        self.step_async(actions)
        return self.step_wait()

    # -- helpers

    def info_column(self, info: np.ndarray, name: str) -> np.ndarray:
        return info[..., self.info_index[name]]

    def __repr__(self) -> str:
        state = 'closed' if self.closed else f'pids {self.pids}'
        return f'EnvPool({self.num_workers} workers x {self.envs_per_worker} envs, D={getattr(self, "obs_dim", "?")}, {state})'
