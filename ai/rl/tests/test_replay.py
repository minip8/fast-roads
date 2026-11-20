"""The GPU replay buffer against a slow, obviously correct reference built from the same stream of transitions."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from replay import ReplayBuffer  # noqa: E402

DEVICES = ['cpu'] + (['cuda'] if torch.cuda.is_available() else [])


class Reference:
    """Per env, the list of transitions in order; a transition's next obs is the next transition's obs or, if its
    step ended the episode, that episode's final obs. Slot numbers follow the documented layout rule (one slot per
    transition, one more after each episode end) only to name what the buffer samples."""

    def __init__(self, E: int):
        self.trans: list[list[dict]] = [[] for _ in range(E)]
        self.slot_to_j: list[dict[int, int]] = [{} for _ in range(E)]
        self.head = np.zeros(E, dtype=np.int64)

    def add(self, obs, action, reward, term, trunc, done_idx, final_obs):
        finals = {int(e): final_obs[i] for i, e in enumerate(done_idx)}
        for e in range(len(obs)):
            assert bool(term[e] or trunc[e]) == (e in finals)
            self.slot_to_j[e][int(self.head[e])] = len(self.trans[e])
            self.trans[e].append(dict(obs=obs[e].copy(), action=action[e].copy(), reward=float(reward[e]),
                                      term=bool(term[e]), trunc=bool(trunc[e]), final=finals.get(e)))
            self.head[e] += 2 if e in finals else 1

    def nstep(self, e: int, j: int, n: int, gamma: float):
        tr = self.trans[e]
        ret = 0.0
        for k in range(n):
            x = tr[j + k]
            ret += gamma ** k * x['reward']
            if x['term']:
                return ret, x['final'], 0.0
            if x['trunc']:
                return ret, x['final'], gamma ** (k + 1)
        return ret, tr[j + n]['obs'], gamma ** n

    def sampleable(self, T: int, n: int) -> set[tuple[int, int]]:
        out = set()
        for e, slots in enumerate(self.slot_to_j):
            for s in slots:
                if s + n <= self.head[e] - 1 and s >= self.head[e] - T:
                    out.add((e, s))
        return out


def fake_step(rng: np.random.Generator, E: int, D: int, p_end: float):
    obs = rng.standard_normal((E, D)).astype(np.float32)
    action = rng.uniform(-1, 1, (E, 2)).astype(np.float32)
    reward = rng.standard_normal(E).astype(np.float32)
    end = rng.random(E) < p_end
    term = end & (rng.random(E) < 0.5)
    trunc = end & ~term
    done_idx = np.flatnonzero(end).astype(np.int64)
    final_obs = rng.standard_normal((len(done_idx), D)).astype(np.float32)
    return obs, action, reward, term, trunc, done_idx, final_obs


def check_samples(buf: ReplayBuffer, ref: Reference, n: int, gamma: float, batches: int, batch: int,
                  obs_dtype: torch.dtype, tuples: bool = True) -> dict[tuple[int, int], int]:
    """Draws batches; every (env, slot) must be sampleable and, with `tuples`, every tuple equal the reference's.
    Returns how often each (env, slot) was drawn."""
    valid = ref.sampleable(buf.T, n)
    counts: dict[tuple[int, int], int] = {}
    cast = (lambda x: torch.from_numpy(x).to(obs_dtype).float().numpy())
    for _ in range(batches):
        buf.commit()
        env, t = buf.sample_index(batch, n)
        obs, act, ret, nxt, disc = (x.cpu().numpy() for x in buf.gather(env, t, n, gamma))
        for i, (e, s) in enumerate(zip(env.tolist(), t.tolist())):
            # the fallback for a row whose candidates were all term slots may sit one slot before the window
            assert (e, s) in valid or (e, s + 1) in ref.slot_to_j[e] and s + 1 >= ref.head[e] - buf.T
            counts[(e, s)] = counts.get((e, s), 0) + 1
            if not tuples:
                continue
            j = ref.slot_to_j[e][s]
            x = ref.trans[e][j]
            r_ret, r_next, r_disc = ref.nstep(e, j, n, gamma)
            np.testing.assert_array_equal(obs[i], cast(x['obs']))
            np.testing.assert_array_equal(act[i], x['action'])
            np.testing.assert_allclose(ret[i], r_ret, rtol=1e-5, atol=1e-5)
            np.testing.assert_array_equal(nxt[i], cast(r_next))
            np.testing.assert_allclose(disc[i], r_disc, rtol=1e-6)
    return counts


@pytest.mark.parametrize('device', DEVICES)
@pytest.mark.parametrize('n', [1, 3, 5])
@pytest.mark.parametrize('p_end', [0.02, 0.15, 0.3])
def test_matches_reference_with_wraparound(device, n, p_end):
    E, D, T, gamma = 3, 7, 40, 0.9
    rng = np.random.default_rng(1000 * n + int(p_end * 100))
    buf = ReplayBuffer(E, D, 2, E * T, device=device)
    ref = Reference(E)
    for step in range(260):  # ~6 wraps of each ring
        data = fake_step(rng, E, D, p_end)
        buf.add(*data)
        ref.add(*data)
        if step in (n + 2, 30, 39, 41, 77, 150, 259):
            buf.commit()
            if not buf.can_sample(n):
                assert not ref.sampleable(T, n)
                continue
            check_samples(buf, ref, n, gamma, batches=3, batch=256, obs_dtype=torch.float32)


@pytest.mark.parametrize('device', DEVICES)
def test_uniform_over_sampleable(device):
    E, D, T, n = 4, 3, 64, 3
    rng = np.random.default_rng(7)
    buf = ReplayBuffer(E, D, 2, E * T, device=device)
    ref = Reference(E)
    for _ in range(150):
        data = fake_step(rng, E, D, 0.1)
        buf.add(*data)
        ref.add(*data)
    buf.commit()
    valid = ref.sampleable(T, n)
    check_samples(buf, ref, n, 0.99, batches=2, batch=512, obs_dtype=torch.float32)
    counts = check_samples(buf, ref, n, 0.99, batches=40, batch=2048, obs_dtype=torch.float32, tuples=False)
    total = sum(counts.values())
    assert len(set(counts) & valid) == len(valid), 'every sampleable transition is drawn'
    expected = total / len(valid)
    freq = np.array([counts.get(k, 0) for k in valid])
    chi2 = ((freq - expected) ** 2 / expected).sum()
    dof = len(valid) - 1
    assert chi2 < dof + 6 * np.sqrt(2 * dof), (chi2, dof)  # ~6 sigma: uniform


@pytest.mark.parametrize('device', DEVICES)
def test_float16_obs_and_episode_of_one_step(device):
    E, D, T, n = 2, 5, 50, 5
    buf = ReplayBuffer(E, D, 2, E * T, device=device, obs_dtype=torch.float16)
    ref = Reference(E)
    rng = np.random.default_rng(3)
    for step in range(120):
        obs, action, reward, term, trunc, _, _ = fake_step(rng, E, D, 0.0)
        # env 0: every third step ends (alternating terminate/truncate); env 1: one-step episodes now and then
        term[:] = trunc[:] = False
        if step % 3 == 0:
            (term if step % 2 else trunc)[0] = True
        if step % 7 in (0, 1):
            term[1] = True
        done_idx = np.flatnonzero(term | trunc).astype(np.int64)
        final_obs = rng.standard_normal((len(done_idx), D)).astype(np.float32)
        buf.add(obs, action, reward, term, trunc, done_idx, final_obs)
        ref.add(obs, action, reward, term, trunc, done_idx, final_obs)
    check_samples(buf, ref, n, 0.95, batches=5, batch=512, obs_dtype=torch.float16)


def test_nothing_sampleable_before_n_steps():
    buf = ReplayBuffer(2, 3, 2, 200, device='cpu')
    rng = np.random.default_rng(0)
    for _ in range(3):
        obs, action, reward, term, trunc, _, _ = fake_step(rng, 2, 3, 0.0)
        z = np.zeros(2, bool)
        buf.add(obs, action, reward, z, z, np.zeros(0, np.int64), np.zeros((0, 3), np.float32))
    assert not buf.can_sample(1), 'nothing before a commit'
    buf.commit()
    assert not buf.can_sample(3)
    assert buf.can_sample(2)


# ---- concurrency: the writer adds while the reader commits and samples -------------------------------------------

def encoded_stream(E: int, steps: int, seed: int):
    """Transition j of env e has obs [e, j, 0], action [j, -j], reward j/1000; the final obs of an episode ending
    at j is [e, j, 1]. Episode ends come from a fixed table, so a reader can rebuild any tuple from (e, j)."""
    rng = np.random.default_rng(seed)
    end = rng.random((E, steps)) < 0.05
    term = end & (rng.random((E, steps)) < 0.5)
    return end, term


def expected(e: int, j: int, n: int, gamma: float, end, term):
    ret = 0.0
    for k in range(n):
        ret += gamma ** k * (j + k) / 1000
        if end[e, j + k]:
            return ret, [e, j + k, 1], 0.0 if term[e, j + k] else gamma ** (k + 1)
    return ret, [e, j + n, 0], gamma ** n


@pytest.mark.parametrize('device', DEVICES)
def test_concurrent_writer_and_reader(device):
    E, T, n, gamma, steps = 8, 300, 3, 0.9, 3000
    end, term = encoded_stream(E, steps, 5)
    buf = ReplayBuffer(E, 3, 2, E * T, device=device)
    errors: list[BaseException] = []
    stop = threading.Event()

    def write():
        try:
            for j in range(steps):
                obs = np.stack([np.arange(E), np.full(E, j), np.zeros(E)], 1).astype(np.float32)
                action = np.tile(np.array([[j, -j]], np.float32), (E, 1))
                reward = np.full(E, j / 1000, np.float32)
                d = np.flatnonzero(end[:, j]).astype(np.int64)
                final = np.stack([d, np.full(len(d), j), np.ones(len(d))], 1).astype(np.float32)
                buf.add(obs, action, reward, end[:, j] & term[:, j], end[:, j] & ~term[:, j], d, final)
                time.sleep(0.0002)  # an env step's pace, so the reader interleaves
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            stop.set()

    writer = threading.Thread(target=write)
    writer.start()
    checked = 0
    while not errors and (not stop.is_set() or checked == 0):
        buf.commit()
        if not buf.can_sample(n):
            continue
        obs, act, ret, nxt, disc = (x.cpu().numpy() for x in buf.sample(1024, n, gamma))
        for i in range(len(obs)):
            e, j, flag = obs[i].astype(int)
            assert flag == 0 and act[i].tolist() == [j, -j]
            r_ret, r_next, r_disc = expected(e, j, n, gamma, end, term)
            assert abs(ret[i] - r_ret) < 1e-5 and nxt[i].tolist() == r_next and abs(disc[i] - r_disc) < 1e-6
        checked += len(obs)
    writer.join()
    assert not errors, errors
    assert checked >= 5 * 1024
