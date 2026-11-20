"""EnvPool throughput: env steps/s for several (workers, envs per worker) layouts, lcf1 at Melbourne, random-ish actions
(steer uniform +-0.2, pedal uniform 0..1), so crashes and automatic resets are part of the figure.

    python bench_pool.py [seconds per layout, default 5] [layouts, e.g. 6x8,12x4]
    python bench_pool.py --rss     # worker memory: 8 envs on one circuit, and with all 24 circuits built
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envpool import EnvPool  # noqa: E402

LAYOUTS = [(1, 8), (4, 8), (5, 8), (6, 8), (6, 16), (8, 8), (10, 8), (12, 4)]
CONFIG = {'reset': {'tracks': ['melbourne'], 'cars': ['lcf1']}}


def rss_mb(pid: int) -> float:
    with open(f'/proc/{pid}/status') as f:
        for line in f:
            if line.startswith('VmRSS:'):
                return int(line.split()[1]) / 1024
    return float('nan')


def actions(rng: np.random.Generator, n: int) -> np.ndarray:
    return np.stack([rng.uniform(-0.2, 0.2, n), rng.uniform(0, 1, n)], 1).astype(np.float32)


def bench(workers: int, envs: int, secs: float) -> dict:
    with EnvPool(workers, envs, CONFIG, seed=1) as pool:
        rng = np.random.default_rng(0)
        pool.reset()
        for _ in range(20):
            pool.step(actions(rng, pool.num_envs))
        load0 = os.getloadavg()[0]
        steps = ends = 0
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < secs:
            r = pool.step(actions(rng, pool.num_envs))
            steps += 1
            ends += len(r.done_idx)
        dt = time.perf_counter() - t0
        rss = sum(rss_mb(p) for p in pool.pids)
    return dict(sps=steps * workers * envs / dt, step_ms=1000 * dt / steps, ends=ends, rss=rss, load=load0)


def measure_rss() -> None:
    def run(cfg: dict, steps: int) -> tuple[float, float]:
        with EnvPool(1, 8, cfg, seed=2) as pool:
            pool.reset()
            after_init = rss_mb(pool.pids[0])
            rng = np.random.default_rng(1)
            for _ in range(steps):
                pool.step(actions(rng, 8))
            return after_init, rss_mb(pool.pids[0])

    a, b = run(CONFIG, 400)
    print(f'1 worker x 8 envs, melbourne only:        RSS {a:6.0f} MB after reset, {b:6.0f} MB after 400 steps')
    with EnvPool(1, 1) as p:
        tracks = p.tracks
    a, b = run({'reset': {'tracks': tracks, 'cars': ['lcf1', 'lcgt3', 'drift']}, 'episodeSecs': 3}, 600)
    print(f'1 worker x 8 envs, all {len(tracks)} circuits, 3 cars: RSS {a:6.0f} MB after reset, {b:6.0f} MB after 600 '
          f'steps of 3 s episodes')


def main() -> None:
    if '--rss' in sys.argv:
        measure_rss()
        return
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    layouts = [tuple(int(x) for x in s.split('x')) for s in sys.argv[2].split(',')] if len(sys.argv) > 2 else LAYOUTS
    print(f'{os.cpu_count()} logical cores, {secs:g} s per layout, lcf1 melbourne, random actions')
    print(f"{'layout':>7} {'envs':>5} {'steps/s':>8} {'ms/step':>8} {'resets':>6} {'RSS MB':>7} {'load':>5}")
    for w, e in layouts:
        r = bench(w, e, secs)
        print(f"{f'{w}x{e}':>7} {w * e:>5} {r['sps']:>8.0f} {r['step_ms']:>8.1f} {r['ends']:>6} {r['rss']:>7.0f} "
              f"{r['load']:>5.1f}", flush=True)


if __name__ == '__main__':
    main()
