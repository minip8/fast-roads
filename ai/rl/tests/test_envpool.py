"""EnvPool and evaluate_laps against the built worker (npm run build:env). About 45 s."""
import gc
import os
import signal
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from envpool import WORKER, EnvPool, EnvPoolError, StepResult  # noqa: E402
from evaluate import evaluate_laps, pinned_laps  # noqa: E402
from reward import ENV_REWARD, Shaper  # noqa: E402

pytestmark = pytest.mark.skipif(not os.path.exists(WORKER), reason='build/env/worker.mjs missing: npm run build:env')


def our_workers() -> list[int]:
    """Live child processes of this test process running the worker."""
    me, pids = os.getpid(), []
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            with open(f'/proc/{d}/stat') as f:
                ppid = int(f.read().rsplit(')', 1)[1].split()[1])
            with open(f'/proc/{d}/cmdline', 'rb') as f:
                cmd = f.read()
        except (OSError, IndexError, ValueError):
            continue
        if ppid == me and b'worker.mjs' in cmd:
            pids.append(int(d))
    return pids


def random_actions(rng: np.random.Generator, n: int) -> np.ndarray:
    return np.stack([rng.uniform(-0.2, 0.2, n), rng.uniform(-0.3, 1, n)], 1).astype(np.float32)


def test_autopilot_reproduces_pinned_melbourne_laps():
    combos = [('melbourne', 'lcf1'), ('melbourne', 'lcgt3'), ('melbourne', 'drift')]
    res = evaluate_laps(None, combos, num_workers=3)
    pinned = pinned_laps()
    assert pinned[('melbourne', 'lcf1')] == 116.548
    for r in res:
        assert r['end_reason'] == 'lap_done', r
        assert r['lap_valid'] and r['wall_contact_steps'] == 0 and r['off_track_time'] == 0 and r['pit_lane_time'] == 0
        assert round(r['lap_time'], 3) == pinned[(r['track'], r['car'])], r
        assert r['steps'] > 2000 and r['min_speed'] > 10 and r['episode_time'] > r['lap_time']
    assert our_workers() == []


def test_pit_lane_in_info_and_the_trainers_reward():
    """Steered into Melbourne's open pit exit (after the line, on the right) with the trainer's env config: the env
    pays no progress there and leaves the penalty to the trainer (reward.py), which charges it by speed."""
    with EnvPool(1, 1, {'reward': ENV_REWARD}) as pool:
        ix, ox = pool.info_index, pool.obs_index
        sh = Shaper(ix, 1 / pool.config['actionHz'])
        obs, info = pool.reset({'s': 5266.0, 'lat': -4.3, 'heading': 0.0, 'speed': 25.0})
        seen = 0
        for _ in range(120):
            s, edge = info[0, ix['lap_s']], obs[0, ox['edge_right']] * 10
            steer = float(np.clip(-0.08 * (edge + 4), -0.15, 0.15)) if 90 < s < 1000 else 0.0
            r = pool.step(np.array([[steer, 0.3]], np.float32))
            obs, info = r.obs, r.info
            assert len(r.done_idx) == 0
            row = info[0]
            assert row[ix['reward_pit_lane']] == 0   # (the env's own term is off: ENV_REWARD)
            if row[ix['pit_lane_time']] == 0.05:
                seen += 1
                assert obs[0, ox['in_pit_lane']] == 1 and row[ix['reward_progress']] == 0
                assert row[ix['lap_valid_now']] == 0
                assert sh(info)[0] == pytest.approx(-2 * abs(row[ix['speed']]) * 0.05, rel=1e-5)
            if row[ix['lap_valid_now']] == 0 and s > 200:
                break
        assert seen > 0


def test_determinism_and_worker_seeds():
    cfg = {'reset': {'cars': ['lcf1', 'lcgt3']}}

    def run(workers: int, envs: int, seed: int, actions: list[np.ndarray]) -> list[StepResult]:
        with EnvPool(workers, envs, cfg, seed=seed) as pool:
            pool.reset()
            return [pool.step(a) for a in actions]

    rng = np.random.default_rng(3)
    actions = [random_actions(rng, 6) for _ in range(200)]
    a, b = run(2, 3, 11, actions), run(2, 3, 11, actions)
    # worker 1 of the 2 x 3 pool is a 1 x 3 pool seeded with seed + 100003
    c = run(1, 3, 11 + 100003, [x[3:] for x in actions])
    for ra, rb, rc in zip(a, b, c):
        for f in ('obs', 'reward', 'terminated', 'truncated', 'info', 'done_idx', 'final_obs'):
            np.testing.assert_array_equal(getattr(ra, f), getattr(rb, f), err_msg=f)
        np.testing.assert_array_equal(ra.obs[3:], rc.obs)
        np.testing.assert_array_equal(ra.info[3:], rc.info)
        np.testing.assert_array_equal(ra.reward[3:], rc.reward)
    assert not np.array_equal(a[-1].obs[:3], a[-1].obs[3:])


def test_auto_reset_bookkeeping():
    with EnvPool(2, 3, {'episodeSecs': 2}, seed=5) as pool:
        N, D, F = pool.num_envs, pool.obs_dim, pool.info_dim
        assert (N, D, F) == (6, 164, 30) and len(pool.obs_spec) == D and pool.obs_index['speed_fwd'] == 3
        assert pool.info_fields[-2:] == ['pit_lane_time', 'reward_pit_lane'] and pool.ready['obsVersion'] == 3
        obs, info = pool.reset()
        assert obs.shape == (N, D) and obs.dtype == np.float32 and info.shape == (N, F) and info.dtype == np.float64
        assert (info[:, pool.info_index['episode']] == 1).all()
        rng, ended = np.random.default_rng(0), 0
        i_end, i_ep, i_t = pool.info_index['end_reason'], pool.info_index['episode'], pool.info_index['episode_time']
        episodes = info[:, i_ep].copy()
        for _ in range(100):
            r = pool.step(random_actions(rng, N))
            assert r.obs.shape == (N, D) and r.obs.dtype == np.float32
            assert r.reward.shape == (N,) and r.reward.dtype == np.float32
            assert r.terminated.dtype == bool and r.truncated.dtype == bool and r.info.dtype == np.float64
            assert r.done_idx.dtype == np.int64 and r.final_obs.shape == (len(r.done_idx), D)
            assert r.final_obs.dtype == np.float32
            done = r.terminated | r.truncated
            np.testing.assert_array_equal(np.flatnonzero(done), r.done_idx)
            assert (r.info[done, i_end] > 0).all() and (r.info[~done, i_end] == 0).all()
            for j, g in enumerate(r.done_idx):
                assert not np.array_equal(r.final_obs[j], r.obs[g])
                if r.truncated[g]:
                    assert pool.end_reasons[int(r.info[g, i_end])] == 'time_limit'
                    assert r.info[g, i_t] == pytest.approx(2.0)
            # an ended env's info is its last step's (same episode number); the next step starts a new one
            assert (r.info[:, i_ep] == episodes).all()
            episodes[done] += 1
            ended += len(r.done_idx)
        # 100 steps of 2 s episodes (40 steps): every env ended at least twice, by time out or earlier
        assert ended >= 2 * N
        # returned arrays are not overwritten by later steps
        kept = {f: getattr(r, f) for f in ('obs', 'reward', 'info', 'final_obs')}
        copies = {f: v.copy() for f, v in kept.items()}
        for _ in range(3):
            pool.step(random_actions(rng, N))
        for f in kept:
            np.testing.assert_array_equal(kept[f], copies[f])


def test_reset_options_per_env_and_seed_offset():
    cfg = {'reset': {'tracks': ['melbourne', 'monaco'], 'cars': ['lcf1', 'drift']}}
    with EnvPool(2, 2, cfg, seed=1) as pool:
        it, ic = pool.info_index['track_index'], pool.info_index['car_index']
        want = [('monaco', 'drift'), ('melbourne', 'lcf1'), None, ('monaco', 'lcf1')]
        _, info = pool.reset([None if w is None else {'track': w[0], 'car': w[1]} for w in want])
        for g, w in enumerate(want):
            if w:
                assert pool.tracks[int(info[g, it])] == w[0] and pool.cars[int(info[g, ic])] == w[1]
        r = pool.step(np.zeros((4, 2), np.float32))
        assert pool.tracks[int(r.info[0, it])] == 'monaco'
        # one dict with a seed: global env g gets seed + g, so a list with those seeds gives the same start
        o1, _ = pool.reset({'seed': 40, 'track': 'melbourne', 'car': 'lcf1', 'start': 'random'})
        o2, _ = pool.reset([{'seed': 40 + g} for g in range(4)])
        np.testing.assert_array_equal(o1, o2)
        assert len({o.tobytes() for o in o1}) == 4


def test_error_reply_keeps_the_pool():
    with EnvPool(2, 1) as pool:
        pool.reset()
        with pytest.raises(EnvPoolError, match='unknown track') as e:
            pool.reset({'track': 'nowhere'})
        assert not e.value.fatal and not pool.closed
        assert pool.step(np.full((2, 2), np.nan, np.float32)).obs.shape == (2, 164)


def test_dead_worker_raises_and_close_leaves_no_children():
    pool = EnvPool(3, 2)
    pids = pool.pids
    assert sorted(our_workers()) == sorted(pids)
    pool.reset()
    os.kill(pids[1], signal.SIGKILL)
    with pytest.raises(EnvPoolError, match=r'worker 1 .*exited with status -9') as e:
        for _ in range(5):   # the first write may still go into the pipe
            pool.step(np.zeros((6, 2), np.float32))
    assert e.value.fatal and 'last stderr lines' in str(e.value)
    assert pool.closed and our_workers() == []
    pool.close()   # idempotent
    with pytest.raises(EnvPoolError, match='closed'):
        pool.step(np.zeros((6, 2), np.float32))
    # a pool dropped without close() is shut down by the garbage collector
    pool = EnvPool(2, 1)
    assert len(our_workers()) == 2
    del pool, e
    gc.collect()
    assert our_workers() == []
