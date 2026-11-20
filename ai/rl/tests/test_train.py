"""The training loop's plumbing on a gymnasium env: a failing thread stops the run, resume continues the counters,
the pink noise generator, the episode statistics, the config overrides."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import load_config, parse_set  # noqa: E402
from gym_pool import GymPool  # noqa: E402
from train import EpisodeStats, PinkNoise, run  # noqa: E402


def quick_cfg(**sets):
    base = ['sac.actor.hidden=32', 'sac.critic.hidden=32', 'sac.critic.blocks=1', 'sac.num_quantiles=8',
            'sac.batch_size=64', 'sac.compile=false', 'replay.capacity=20000', 'collect.random_steps=200',
            'collect.learning_starts=200', 'collect.min_utd=1', 'log_every_secs=0.5', 'eval.every_secs=1e9',
            f"device={'cuda' if torch.cuda.is_available() else 'cpu'}"]
    return load_config(sets=base + [f'{k}={v}' for k, v in sets.items()])


class FailingPool(GymPool):
    def __init__(self, fail_at: int):
        super().__init__('Pendulum-v1', 2)
        self.calls, self.fail_at = 0, fail_at

    def step(self, actions):
        self.calls += 1
        if self.calls == self.fail_at:
            raise ValueError('boom')
        return super().step(actions)


def test_failure_in_collector_stops_the_run(tmp_path):
    cfg = quick_cfg(max_env_steps=100_000)
    with pytest.raises(RuntimeError, match='boom'):
        run(cfg, tmp_path / 'r', lambda c: FailingPool(400), None)
    lines = [json.loads(x) for x in (tmp_path / 'r' / 'train.jsonl').read_text().splitlines()]
    assert 'collector' in lines[-1]['error'][0] and 'boom' in lines[-1]['error'][0]
    assert (tmp_path / 'r' / 'latest.pt').exists()


def test_resume_continues_counters(tmp_path):
    first = run(quick_cfg(max_env_steps=1000), tmp_path / 'r', lambda c: GymPool('Pendulum-v1', 2), None)
    steps, updates = first.shared.env_steps, first.shared.updates
    assert updates > 500
    second = run(quick_cfg(max_env_steps=2000), tmp_path / 'r', lambda c: GymPool('Pendulum-v1', 2), None,
                 resume=True)
    assert second.shared.env_steps >= 2000 and second.shared.updates > updates
    # refilled before learning again: about learning_starts more steps than updates
    assert second.shared.env_steps - steps - (second.shared.updates - updates) >= 200


def test_pink_noise_is_unit_variance_and_correlated():
    noise = PinkNoise(64, 2, 1000, np.random.default_rng(0))
    x = np.stack([noise.sample() for _ in range(1000)], -1)  # [N, A, steps]
    assert abs(x.std() - 1) < 0.05 and abs(x.mean()) < 0.1
    lag1 = np.mean(x[..., 1:] * x[..., :-1])
    assert lag1 > 0.6, lag1  # white noise: 0
    noise.reset(np.array([3]))
    assert noise.pos[3] == noise.chunk


def test_episode_stats():
    fields = list(EpisodeStats.FIELDS)
    ix = {k: i for i, k in enumerate(fields)}
    st = EpisodeStats(2, ix, ['none', 'flipped', 'wrong_way', 'stuck', 'wall', 'time_limit', 'lap_done'])
    info = np.zeros((2, len(fields)))
    info[:, ix['speed']] = [10, 20]
    info[:, ix['wall_contact']] = [1, 0]
    st.step(np.array([1.0, 2.0]), info, np.array([], np.int64))
    info[1, ix['lap_done']], info[1, ix['lap_time']], info[1, ix['lap_valid']] = 1, 95.5, 1
    info[1, ix['end_reason']], info[1, ix['episode_progress_m']] = 5, 120
    st.step(np.array([1.0, 3.0]), info, np.array([1]))
    out = st.drain()
    assert out['episodes'] == 1 and out['ep_return'] == 5.0 and out['ep_length'] == 2
    assert out['ends'] == {'time_limit': 1} and out['ep_speed'] == 20 and out['ep_progress'] == 120
    assert out['laps'] == 1 and out['lap_best_valid'] == 95.5
    assert st.drain() == {'episodes': 0}


def test_config_overrides(tmp_path):
    assert parse_set(['a.b=1', 'env.reset.tracks=["x","y"]', 'c=pink']) == \
        {'a': {'b': 1}, 'env': {'reset': {'tracks': ['x', 'y']}}, 'c': 'pink'}
    f = tmp_path / 'c.json'
    f.write_text(json.dumps({'sac': {'gamma': 0.99, 'critic': {'kind': 'mlp'}}}))
    cfg = load_config(f, ['sac.critic.hidden=128', 'env.tc=false'])
    assert cfg.sac.gamma == 0.99 and cfg.sac.critic.kind == 'mlp' and cfg.sac.critic.hidden == 128
    assert cfg.sac.actor.hidden == 256 and cfg.env == {'tc': False}
    with pytest.raises(KeyError):
        load_config(sets=['sac.nope=1'])
