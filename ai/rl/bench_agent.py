"""Learner throughput: updates/s of the SAC update with the GPU replay buffer (sampling included).

    python bench_agent.py                                    # the default config
    python bench_agent.py --set sac.batch_size=1024 --set sac.compile=true --set sac.amp=off

Fills a buffer of the configured capacity with random transitions (40 envs, D = 145, 1% episode ends), runs a
warm-up (CUDA graph capture, compilation) and times `--secs` of updates. Prints warm-up time, updates/s and VRAM.
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import torch

from config import load_config
from replay import ReplayBuffer
from sac import SAC


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', action='append', default=[])
    ap.add_argument('--secs', type=float, default=10.0)
    ap.add_argument('--envs', type=int, default=40)
    ap.add_argument('--obs-dim', type=int, default=145)
    ap.add_argument('--fill', type=int, default=20_000, help='env steps written (all envs each)')
    args = ap.parse_args()
    cfg = load_config(sets=args.set)
    torch.manual_seed(0)
    E, D = args.envs, args.obs_dim
    rb = ReplayBuffer(E, D, 2, cfg.replay.capacity, device=cfg.device, obs_dtype=getattr(torch, cfg.replay.obs_dtype))
    rng = np.random.default_rng(0)
    obs = rng.standard_normal((E, D)).astype(np.float32)
    for _ in range(args.fill):
        end = rng.random(E) < 0.01
        term = end & (rng.random(E) < 0.5)
        d = np.flatnonzero(end)
        rb.add(obs, rng.uniform(-1, 1, (E, 2)).astype(np.float32), rng.standard_normal(E).astype(np.float32),
               term, end & ~term, d, obs[d])
        if _ % 500 == 0:
            rb.commit()
    rb.commit()
    agent = SAC(cfg.sac, D, 2, cfg.device)
    agent.replay = rb
    k = cfg.sac.updates_per_call
    t0 = time.perf_counter()
    agent.update(k)
    agent.read_metrics()
    warm = time.perf_counter() - t0
    n0, t0 = agent.updates, time.perf_counter()
    while time.perf_counter() - t0 < args.secs:
        agent.update(k)
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    m = agent.read_metrics()
    s = cfg.sac
    print(f'batch {s.batch_size} compile {s.compile} graph {s.cuda_graph} amp {s.amp} tf32 {s.tf32} '
          f'critic {s.critic.kind} {s.critic.hidden}x{s.critic.blocks}: warm-up {warm:.1f} s, '
          f'{(agent.updates - n0) / dt:.0f} updates/s; replay {rb.memory_bytes() / 2**30:.2f} GiB, '
          f'peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB; loss {m["critic_loss"]:.3f}')


if __name__ == '__main__':
    main()
