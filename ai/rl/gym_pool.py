"""A gymnasium environment made to look like `envpool.EnvPool` (same `StepResult` semantics, `final_obs`
included), so the trainer can be checked end to end on a known task (sanity_pendulum.py, the tests)."""
from __future__ import annotations

from dataclasses import dataclass

import gymnasium as gym
import numpy as np


@dataclass
class StepResult:
    obs: np.ndarray
    reward: np.ndarray
    terminated: np.ndarray
    truncated: np.ndarray
    info: np.ndarray
    done_idx: np.ndarray
    final_obs: np.ndarray


class GymPool:
    """`num_envs` copies of `env_id`; actions in [-1, 1] are mapped onto the env's Box. No info fields."""

    def __init__(self, env_id: str, num_envs: int, seed: int = 0):
        self.envs = [gym.make(env_id) for _ in range(num_envs)]
        space = self.envs[0].action_space
        self.low, self.high = space.low.astype(np.float32), space.high.astype(np.float32)
        self.num_envs = num_envs
        self.obs_dim = self.envs[0].observation_space.shape[0]
        self.act_dim = space.shape[0]
        self.info_dim, self.info_fields, self.info_index, self.end_reasons = 0, [], {}, []
        self.seed = seed
        self._obs = np.zeros((num_envs, self.obs_dim), np.float32)

    def reset(self, options=None):
        for i, env in enumerate(self.envs):
            self._obs[i] = env.reset(seed=self.seed + i)[0]
        return self._obs.copy(), np.zeros((self.num_envs, 0))

    def step(self, actions: np.ndarray) -> StepResult:
        n = self.num_envs
        a = self.low + (np.clip(actions, -1, 1) + 1) * 0.5 * (self.high - self.low)
        reward = np.zeros(n, np.float32)
        term, trunc = np.zeros(n, bool), np.zeros(n, bool)
        done, final = [], []
        for i, env in enumerate(self.envs):
            o, r, te, tr, _ = env.step(a[i])
            reward[i], term[i], trunc[i] = r, te, tr
            if te or tr:
                done.append(i)
                final.append(o)
                o = env.reset()[0]
            self._obs[i] = o
        final_obs = np.array(final, np.float32).reshape(len(done), self.obs_dim)
        return StepResult(self._obs.copy(), reward, term, trunc, np.zeros((n, 0)), np.array(done, np.int64), final_obs)

    def close(self) -> None:
        for env in self.envs:
            env.close()


def gym_evaluator(env_id: str, episodes: int = 5, seed: int = 10_000):
    """An evaluator for train.Trainer: deterministic episodes; score = -mean return (lower is better)."""

    def evaluate(act_fn) -> tuple[list[dict], float]:
        env = gym.make(env_id)
        space = env.action_space
        records = []
        for k in range(episodes):
            o, _ = env.reset(seed=seed + k)
            ret, steps, done = 0.0, 0, False
            while not done:
                a = act_fn(np.asarray(o, np.float32)[None])[0]
                a = space.low + (np.clip(a, -1, 1) + 1) * 0.5 * (space.high - space.low)
                o, r, te, tr, _ = env.step(a)
                ret, steps, done = ret + float(r), steps + 1, te or tr
            records.append({'episode': k, 'return': ret, 'steps': steps})
        env.close()
        return records, -float(np.mean([r['return'] for r in records]))

    return evaluate
