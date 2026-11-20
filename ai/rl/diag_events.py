"""When in a training episode do excursions happen? python diag_events.py runs/<name> [steps] [noise 0/1]

Runs the run's latest policy in its training env (random starts, one env per circuit) and prints, for each kind of
event (off track, pit lane, wall), how many there were per episode and how long after the episode's start."""
import json
import sys
from pathlib import Path

import numpy as np
import torch

from config import load_config
from envpool import EnvPool
from reward import ENV_REWARD
from sac import CpuPolicy
from train import env_combos, merge

run = Path(sys.argv[1])
steps = int(sys.argv[2]) if len(sys.argv) > 2 else 4000
noisy = (sys.argv[3] if len(sys.argv) > 3 else '1') == '1'
cfg = load_config(base=json.loads((run / 'config.json').read_text()))
ck = torch.load(run / 'latest.pt', weights_only=False, map_location='cpu')
combos = env_combos(cfg)
with EnvPool(2, len(combos) // 2, merge(cfg.env, {'reward': ENV_REWARD}), seed=123, worker_path=str(run / 'worker.mjs')) as pool:
    policy = CpuPolicy(cfg.sac, pool.obs_dim, 2)
    policy.load(ck['policy'])
    ix = pool.info_index
    obs, _ = pool.reset([{'track': t, 'car': c} for t, c in combos])
    n = pool.num_envs
    was = np.zeros((n, 3), bool)
    events = {k: [] for k in ('off', 'pit', 'wall')}
    episodes, ends = 0, {}
    per_track = {t: [0, 0] for t, _ in combos}
    for _ in range(steps):
        res = pool.step(policy(obs, deterministic=not noisy))
        info = res.info
        now = np.stack([info[:, ix['off_track_time']] > 0, info[:, ix['pit_lane_time']] > 0, info[:, ix['wall_contact']] > 0], 1)
        began = now & ~was
        for e, k in zip(*np.nonzero(began)):
            events[('off', 'pit', 'wall')[k]].append(info[e, ix['episode_time']])
            per_track[combos[e][0]][0] += 1
        was = now
        was[res.done_idx] = False
        for e in res.done_idx:
            episodes += 1
            per_track[combos[e][0]][1] += 1
            r = pool.end_reasons[int(info[e, ix['end_reason']])]
            ends[r] = ends.get(r, 0) + 1
        obs = res.obs
print(f"{'sampled' if noisy else 'deterministic'} actions, {steps * n} steps, {episodes} episodes ended: {ends}")
for k, ts in events.items():
    ts = np.array(ts)
    if len(ts):
        print(f"  {k}: {len(ts)} events ({len(ts) / max(1, steps * n / 1800):.2f} per 90 s); within 2 s of the start {np.mean(ts < 2):.0%},"
              f" 2-5 s {np.mean((ts >= 2) & (ts < 5)):.0%}, 5-15 s {np.mean((ts >= 5) & (ts < 15)):.0%}, later {np.mean(ts >= 15):.0%}")
print('  events per track:', {t: v[0] for t, v in per_track.items() if v[0]})
