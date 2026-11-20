"""Learning sanity check: the full training loop (collector thread, GPU replay, n-step, truncation bootstrap, SAC,
evaluation thread) through GymPool on Pendulum-v1, which a working SAC solves (mean return > -200) in 10-20k steps.

    python sanity_pendulum.py [--steps 20000]
    pytest -m sanity tests/test_sanity.py

Only what Pendulum needs differs from the racing defaults: 4 envs, a 100k buffer, 2,000 random steps before
learning, and `min_utd` = `utd` = 1 so collection and updates run in lockstep (Python steps Pendulum far faster than
the GPU updates, so without it "within 20k steps" would mean little). Networks, n-step, gamma, reward scale and
everything else are the defaults.
"""
from __future__ import annotations

import argparse
import json
import shutil

import numpy as np

from config import load_config
from gym_pool import GymPool, gym_evaluator
from sac import CpuPolicy
from train import RUNS, run

ENV = 'Pendulum-v1'


def sanity(steps: int = 20_000, name: str = 'sanity-pendulum', seed: int = 0) -> dict:
    run_dir = RUNS / name
    shutil.rmtree(run_dir, ignore_errors=True)
    cfg = load_config(sets=[
        f'seed={seed}', f'max_env_steps={steps}', 'replay.capacity=100000',
        'collect.random_steps=2000', 'collect.learning_starts=2000', 'collect.utd=1', 'collect.min_utd=1',
        'eval.every_secs=15', 'log_every_secs=5', 'checkpoint_every_secs=1e9'])
    trainer = run(cfg, run_dir, lambda c: GymPool(ENV, 4, seed=c.seed), gym_evaluator(ENV, episodes=5))
    policy = CpuPolicy(cfg.sac, trainer.obs_dim, trainer.act_dim)
    policy.load(trainer.agent.policy_state())
    records, score = gym_evaluator(ENV, episodes=10, seed=20_000)(lambda o: policy(o, deterministic=True))
    curve = []
    for line in (run_dir / 'train.jsonl').read_text().splitlines():
        d = json.loads(line)
        if d.get('episodes'):
            curve.append((d['env_steps'], d['ep_return'], d['updates']))
    evals = [(e['env_steps'], -e['score']) for e in trainer.eval.results]
    return {'final_mean_return': -score, 'final_returns': [r['return'] for r in records], 'curve': curve,
            'evals': evals, 'env_steps': trainer.shared.env_steps, 'updates': trainer.shared.updates}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--steps', type=int, default=20_000)
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()
    out = sanity(args.steps, seed=args.seed)
    print('\nenv steps -> mean training-episode return (stochastic policy):')
    for s, r, u in out['curve']:
        print(f'  {s:>7,}  {r:8.1f}   ({u:,} updates)')
    print('evaluations (deterministic, 5 episodes):', ', '.join(f'{s:,}: {r:.1f}' for s, r in out['evals']))
    print(f"final deterministic mean return over 10 episodes: {out['final_mean_return']:.1f} "
          f"(min {np.min(out['final_returns']):.1f}) -> {'PASS' if out['final_mean_return'] > -200 else 'FAIL'}")


if __name__ == '__main__':
    main()
