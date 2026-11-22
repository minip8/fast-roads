"""Training loop: a collector thread steps the EnvPool and fills the GPU replay buffer, the main thread runs SAC
updates, an evaluation thread drives timed laps with snapshots of the deterministic actor.

    python train.py --name <run> [--config file.json] [--set key.sub=value ...] [--resume]

Run folder `ai/rl/runs/<name>/`: config.json, train.jsonl, eval.jsonl, latest.pt (at every evaluation and on exit),
best.pt + best.npz (lowest evaluation score: the valid lap times summed over the combos, an invalid or unfinished
lap counting `eval.invalid_lap_secs`), ckpt-<env steps>.pt every `checkpoint_every_secs`. `--resume` continues
from latest.pt (the replay buffer refills `learning_starts` transitions with the loaded policy first).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import signal
import sys
import threading
import time
import traceback
from collections import Counter
from pathlib import Path
from typing import Any, Callable

import numpy as np
import torch

from config import TrainConfig, load_config, merge, save_config, to_dict
from networks import RunningStats
from replay import ReplayBuffer
from reward import ENV_REWARD, Shaper
from sac import SAC, CpuPolicy

RUNS = Path(__file__).resolve().parent / 'runs'
Evaluator = Callable[[Callable[[np.ndarray], np.ndarray]], tuple[list[dict], float]]


# ---- exploration noise -------------------------------------------------------------------------------------------

class PinkNoise:
    """Per env and action dim, unit-variance 1/f ("pink") Gaussian noise sequences (Eberhard et al. 2023), drawn
    `chunk` steps at a time by the FFT method of Timmer & Koenig (1995), as the `colorednoise` package does: random
    Fourier coefficients with power ~ 1/f (frequencies below 1/chunk flattened), inverse FFT, divided by the exact
    standard deviation. An env whose episode ended starts a fresh sequence."""

    def __init__(self, num_envs: int, act_dim: int, chunk: int, rng: np.random.Generator):
        self.n, self.a, self.chunk, self.rng = num_envs, act_dim, chunk, rng
        f = np.fft.rfftfreq(chunk)
        f[0] = f[1]  # cutoff at the lowest resolvable frequency, 1/chunk
        self.scale = f ** -0.5  # amplitude ~ f^(-beta/2), beta = 1
        w = self.scale[1:].copy()
        w[-1] *= (1 + chunk % 2) / 2.0
        self.sigma = 2 * np.sqrt(np.sum(w ** 2)) / chunk
        self.seq = np.zeros((num_envs, act_dim, chunk), np.float32)
        self.pos = np.full(num_envs, chunk)

    def _draw(self, k: int) -> np.ndarray:
        shape = (k, self.a, len(self.scale))
        re, im = self.rng.normal(size=shape) * self.scale, self.rng.normal(size=shape) * self.scale
        if self.chunk % 2 == 0:
            im[..., -1] = 0
            re[..., -1] *= np.sqrt(2)
        im[..., 0] = 0
        re[..., 0] *= np.sqrt(2)
        return (np.fft.irfft(re + 1j * im, n=self.chunk, axis=-1) / self.sigma).astype(np.float32)

    def sample(self) -> np.ndarray:
        """[N, A] standard normal marginals, correlated in time per env."""
        fresh = np.flatnonzero(self.pos >= self.chunk)
        if len(fresh):
            self.seq[fresh] = self._draw(len(fresh))
            self.pos[fresh] = 0
        out = self.seq[np.arange(self.n), :, self.pos]
        self.pos += 1
        return out

    def reset(self, idx: np.ndarray) -> None:
        self.pos[idx] = self.chunk


# ---- episode statistics ------------------------------------------------------------------------------------------

class EpisodeStats:
    """Per-env accumulators over the info block; finished episodes and laps are kept until `drain`."""

    FIELDS = ('episode_progress_m', 'end_reason', 'wall_contact', 'off_track_time', 'speed', 'lap_done', 'lap_time',
              'lap_valid')

    def __init__(self, num_envs: int, info_index: dict[str, int], end_reasons: list[str]):
        self.ix = {k: info_index[k] for k in self.FIELDS if k in info_index}
        self.end_reasons = end_reasons
        z = lambda: np.zeros(num_envs)  # noqa: E731
        self.ret, self.length, self.wall, self.off, self.speed = z(), z(), z(), z(), z()
        self.episodes: list[dict] = []
        self.laps: list[tuple[float, bool]] = []
        self.total_episodes = 0

    def step(self, reward: np.ndarray, info: np.ndarray, done_idx: np.ndarray) -> None:
        ix = self.ix
        self.ret += reward
        self.length += 1
        if 'wall_contact' in ix:
            self.wall += info[:, ix['wall_contact']] > 0
            self.off += info[:, ix['off_track_time']]
            self.speed += info[:, ix['speed']]
            for g in np.flatnonzero(info[:, ix['lap_done']] > 0):
                self.laps.append((float(info[g, ix['lap_time']]), bool(info[g, ix['lap_valid']] == 1)))
        for g in done_idx:
            ep = {'return': float(self.ret[g]), 'length': int(self.length[g])}
            if 'wall_contact' in ix:
                ep.update(progress=float(info[g, ix['episode_progress_m']]), wall_steps=int(self.wall[g]),
                          off_track=float(self.off[g]), speed=float(self.speed[g] / self.length[g]),
                          end=self.end_reasons[int(info[g, ix['end_reason']])])
            self.episodes.append(ep)
            self.total_episodes += 1
            self.ret[g] = self.length[g] = self.wall[g] = self.off[g] = self.speed[g] = 0

    def drain(self) -> dict:
        eps, laps = self.episodes, self.laps
        self.episodes, self.laps = [], []
        out: dict[str, Any] = {'episodes': len(eps)}
        if eps:
            r = np.array([e['return'] for e in eps])
            out.update(ep_return=float(r.mean()), ep_return_min=float(r.min()), ep_return_max=float(r.max()),
                       ep_length=float(np.mean([e['length'] for e in eps])))
            if 'progress' in eps[0]:
                p = np.array([e['progress'] for e in eps])
                out.update(ep_progress=float(p.mean()), ep_progress_max=float(p.max()),
                           ep_wall_steps=float(np.mean([e['wall_steps'] for e in eps])),
                           ep_off_track=float(np.mean([e['off_track'] for e in eps])),
                           ep_speed=float(np.mean([e['speed'] for e in eps])),
                           ends=dict(Counter(e['end'] for e in eps)))
        if laps:
            valid = [t for t, v in laps if v]
            out.update(laps=len(laps), laps_valid=len(valid), lap_mean=float(np.mean([t for t, _ in laps])),
                       lap_best_valid=min(valid) if valid else None)
        return out


# ---- threads -----------------------------------------------------------------------------------------------------

class Shared:
    """What the threads share: counters (written by one thread each), the stop flag, errors, the published policy."""

    def __init__(self, env_steps: int = 0, updates: int = 0):
        self.env_steps = env_steps
        self.updates = updates
        self.learning = False
        self.learn_steps0 = self.learn_updates0 = 0  # counters when learning (re)started in this process
        self.stop = threading.Event()
        self.errors: list[str] = []
        self.policy: dict | None = None
        self.policy_version = 0
        self.lock = threading.Lock()

    def fail(self, where: str) -> None:
        self.errors.append(f'{where}:\n{traceback.format_exc()}')
        self.stop.set()

    def utd_since_start(self) -> float:
        steps = self.env_steps - self.learn_steps0
        return (self.updates - self.learn_updates0) / steps if steps > 0 else math.inf


class Collector(threading.Thread):
    def __init__(self, cfg: TrainConfig, pool, replay: ReplayBuffer, shared: Shared, obs_stats: RunningStats,
                 act_dim: int, seed: int):
        super().__init__(name='collector', daemon=True)
        self.cfg, self.pool, self.replay, self.shared, self.obs_stats = cfg, pool, replay, shared, obs_stats
        self.stats_lock = threading.Lock()  # guards obs_stats and episode stats
        self.episodes = EpisodeStats(pool.num_envs, pool.info_index, pool.end_reasons)
        self.policy = CpuPolicy(cfg.sac, pool.obs_dim, act_dim)
        self.act_dim = act_dim
        self.rng = np.random.default_rng(seed)
        self.noise = PinkNoise(pool.num_envs, act_dim, cfg.collect.pink_chunk, self.rng) \
            if cfg.collect.noise == 'pink' else None
        if cfg.collect.noise not in ('white', 'pink'):
            raise ValueError(f'unknown noise {cfg.collect.noise!r}')
        self.paused_secs = 0.0
        self.combos = env_combos(cfg)
        # the trainer's own reward from the env's info (reward.py), or the env's reward as it is
        self.shape = Shaper(pool.info_index, 1 / pool.config['actionHz'], cfg.reward) if cfg.reward is not None else None

    def run(self) -> None:
        sh, c = self.shared, self.cfg.collect
        version = -1
        try:
            n = self.pool.num_envs
            obs, _ = self.pool.reset([{'track': t, 'car': k} for t, k in (self.combos[g % len(self.combos)] for g in range(n))]
                                     if c.pin else None)
            while not sh.stop.is_set():
                if c.min_utd > 0 and sh.learning and sh.utd_since_start() < c.min_utd:
                    t0 = time.perf_counter()
                    time.sleep(0.0005)
                    self.paused_secs += time.perf_counter() - t0
                    continue
                if sh.policy_version != version:
                    with sh.lock:
                        version, state = sh.policy_version, sh.policy
                    self.policy.load(state)
                if sh.env_steps < c.random_steps:
                    actions = self.rng.uniform(-1, 1, (n, self.act_dim)).astype(np.float32)
                else:
                    actions = self.policy(obs, None if self.noise is None else self.noise.sample())
                res = self.pool.step(actions)
                reward = res.reward if self.shape is None else self.shape(res.info, res.done_idx)
                self.replay.add(obs, actions, reward, res.terminated, res.truncated, res.done_idx, res.final_obs)
                with self.stats_lock:
                    if self.cfg.sac.obs_norm:
                        self.obs_stats.update(obs)
                    self.episodes.step(reward, res.info, res.done_idx)
                if self.noise is not None:
                    self.noise.reset(res.done_idx)
                obs = res.obs
                sh.env_steps += n
        except BaseException:  # noqa: BLE001
            # Ctrl-C reaches the node workers too: their death may show up here just before the signal handler
            # sets stop, which is then no failure
            if not sh.stop.wait(1.5):
                sh.fail('collector')
        finally:
            self.pool.close()


class EvalThread(threading.Thread):
    """Evaluates snapshots handed over by `submit` (one at a time; a newer one replaces a waiting one)."""

    def __init__(self, cfg: TrainConfig, run_dir: Path, evaluate: Evaluator, shared: Shared, obs_dim: int,
                 act_dim: int, best_score: float):
        super().__init__(name='eval', daemon=True)
        self.cfg, self.run_dir, self.evaluate, self.shared = cfg, run_dir, evaluate, shared
        self.policy = CpuPolicy(cfg.sac, obs_dim, act_dim)
        self.best_score = best_score
        self.cv = threading.Condition()
        self.pending: dict | None = None
        self.results: list[dict] = []  # for the caller (sanity checks)

    def submit(self, checkpoint: dict) -> None:
        with self.cv:
            self.pending = checkpoint
            self.cv.notify()

    def run(self) -> None:
        sh = self.shared
        try:
            while not sh.stop.is_set():
                with self.cv:
                    if self.pending is None:
                        self.cv.wait(0.2)
                        continue
                    ck, self.pending = self.pending, None
                self._evaluate(ck)
        except BaseException:  # noqa: BLE001
            if not sh.stop.is_set():
                sh.fail('evaluation')

    def _evaluate(self, ck: dict) -> None:
        self.policy.load(ck['policy'], averaged=True)
        t0 = time.time()
        records, score = self.evaluate(lambda o: self.policy(o, deterministic=True))
        line = {'time': time.time(), 'env_steps': ck['env_steps'], 'updates': ck['agent']['updates'],
                'eval_secs': round(time.time() - t0, 1), 'score': score, 'best': score < self.best_score,
                'results': records}
        if score < self.best_score:
            self.best_score = score
            ck['best_score'] = score
            atomic_save(ck, self.run_dir / 'best.pt')
            export_from_checkpoint(ck, self.run_dir / 'best.npz')
        if self.cfg.eval.keep_clean and records and all(
                r.get('lap_valid') and r.get('lap_time') and not r.get('wall_contact_steps') for r in records):
            export_from_checkpoint(ck, self.run_dir / f"clean-{ck['env_steps']:010d}.npz")
            with open(self.run_dir / 'clean.jsonl', 'a') as f:
                f.write(json.dumps({'env_steps': ck['env_steps'], 'score': score}) + '\n')
        self.results.append(line)
        with open(self.run_dir / 'eval.jsonl', 'a') as f:
            f.write(json.dumps(line, default=_json_default) + '\n')
        print(f"[eval] steps {ck['env_steps']:,}  score {score:.3f}{'  (best)' if line['best'] else ''}  "
              + ('  '.join(_eval_brief(r) for r in records) if len(records) <= 4 else _eval_count(records)), flush=True)


def _eval_count(records: list[dict]) -> str:
    if 'lap_time' not in records[0]:
        return f'{len(records)} results'
    clean = sum(bool(r['lap_valid'] and r['lap_time'] and not r['wall_contact_steps']) for r in records)
    return f"{clean}/{len(records)} laps clean, {sum(r['lap_time'] is not None for r in records)} finished"


def _eval_brief(r: dict) -> str:
    if 'lap_time' not in r:
        return ' '.join(f'{k} {v:.1f}' if isinstance(v, float) else f'{k} {v}' for k, v in r.items())
    lap = f"{r['lap_time']:.3f}" if r['lap_time'] is not None else '-'
    return (f"{r['track']}/{r['car']}: lap {lap} {'valid' if r['lap_valid'] else 'INVALID'} ({r['end_reason']}), "
            f"walls {r['wall_contact_steps']}, off {r['off_track_time']:.1f} s, {r['mean_speed'] * 3.6:.0f} km/h")


def _json_default(x):
    if isinstance(x, (np.floating, np.integer)):
        return x.item()
    if isinstance(x, float) and not math.isfinite(x):
        return None
    raise TypeError(type(x))


def atomic_save(obj: Any, path: Path) -> None:
    tmp = path.with_suffix(path.suffix + '.tmp')
    torch.save(obj, tmp)
    os.replace(tmp, path)


def export_from_checkpoint(ck: dict, path: Path) -> None:
    """Writes the checkpoint's deterministic actor as a policy .npz (layout in policy_np.py)."""
    cfg = load_config(base=ck['config'])
    agent = SAC(cfg.sac, ck['obs_dim'], ck['act_dim'], 'cpu')
    agent.actor.load_state_dict(ck['policy'].get('actor_ema', ck['policy']['actor']))
    agent.obs_mean.copy_(ck['policy']['obs_mean'])
    agent.obs_inv_std.copy_(ck['policy']['obs_inv_std'])
    agent.export_policy(path)


def to_cpu(x: Any) -> Any:
    if torch.is_tensor(x):
        return x.detach().cpu().clone()
    if isinstance(x, dict):
        return {k: to_cpu(v) for k, v in x.items()}
    if isinstance(x, list):
        return [to_cpu(v) for v in x]
    return x


# ---- the trainer -------------------------------------------------------------------------------------------------

class Trainer:
    def __init__(self, cfg: TrainConfig, run_dir: Path, make_pool: Callable[[TrainConfig], Any],
                 evaluate: Evaluator | None, resume: bool = False):
        self.cfg, self.run_dir = cfg, run_dir
        run_dir.mkdir(parents=True, exist_ok=True)
        save_config(cfg, run_dir / 'config.json')
        torch.manual_seed(cfg.seed)
        self.pool = p = make_pool(cfg)
        try:
            self._build(cfg, run_dir, evaluate, resume)
        except BaseException:
            p.close()
            raise

    def _build(self, cfg: TrainConfig, run_dir: Path, evaluate: Evaluator | None, resume: bool) -> None:
        p = self.pool
        self.obs_dim, self.act_dim = p.obs_dim, getattr(p, 'act_dim', 2)
        if any(cfg.sac.rate_reg) and not cfg.sac.prev_action_index:   # the env's previous-action observations
            cfg.sac.prev_action_index = [self.pool.obs_index[k] for k in ('prev_steer', 'prev_pedal')]
            save_config(cfg, run_dir / 'config.json')
        self.agent = SAC(cfg.sac, self.obs_dim, self.act_dim, cfg.device)
        self.replay = ReplayBuffer(p.num_envs, self.obs_dim, self.act_dim, cfg.replay.capacity, cfg.device,
                                   getattr(torch, cfg.replay.obs_dtype))
        self.agent.replay = self.replay
        self.obs_stats = RunningStats(self.obs_dim, cfg.sac.obs_norm_std_floor)
        self.shared = Shared()
        best = math.inf
        self.start_wall = 0.0  # training seconds before this process (resume)
        if resume:
            ck = torch.load(run_dir / 'latest.pt', weights_only=False, map_location='cpu')
            self.agent.load_state_dict(ck['agent'])
            self.obs_stats.load_state_dict(ck['obs_stats'])
            self.shared.env_steps, self.shared.updates = ck['env_steps'], ck['agent']['updates']
            self.shared.policy, self.shared.policy_version = ck['policy'], 1
            best, self.start_wall = ck.get('best_score', math.inf), ck.get('wall_secs', 0.0)
            print(f"resumed {run_dir.name}: {ck['env_steps']:,} env steps, {ck['agent']['updates']:,} updates",
                  flush=True)
        self.collector = Collector(cfg, p, self.replay, self.shared, self.obs_stats, self.act_dim, cfg.seed + 1)
        self.eval = EvalThread(cfg, run_dir, evaluate, self.shared, self.obs_dim, self.act_dim, best) \
            if evaluate else None
        self.best_score = best
        self.t0 = time.time()

    # -- what the learner shares

    def publish_policy(self) -> None:
        """Freezes the normaliser stats collected so far into the learner and hands actor + stats to the collector."""
        if self.cfg.sac.obs_norm and self.obs_stats.count > 0:
            with self.collector.stats_lock:
                mean, std = self.obs_stats.mean.copy(), self.obs_stats.std()
            self.agent.set_obs_stats(mean, std)
        state = self.agent.policy_state()
        sh = self.shared
        with sh.lock:
            sh.policy, sh.policy_version = state, sh.policy_version + 1

    def checkpoint(self) -> dict:
        with self.collector.stats_lock:
            stats = self.obs_stats.state_dict()
        return {'agent': to_cpu(self.agent.state_dict()), 'policy': self.agent.policy_state(), 'obs_stats': stats,
                'env_steps': self.shared.env_steps, 'config': to_dict(self.cfg), 'obs_dim': self.obs_dim,
                'act_dim': self.act_dim, 'best_score': self.eval.best_score if self.eval else self.best_score,
                'wall_secs': self.start_wall + time.time() - self.t0}

    # -- main loop

    def run(self) -> None:
        cfg, sh, agent = self.cfg, self.shared, self.agent
        c = cfg.collect
        k_max = cfg.sac.updates_per_call
        if sh.policy is None:
            self.publish_policy()  # the untrained actor, for any steps after random_steps and before learning
        self.collector.start()
        if self.eval:
            self.eval.start()
        now = time.time()
        last = {'log': now, 'sync': now, 'eval': now, 'ckpt': now}
        prev = {'t': now, 'steps': sh.env_steps, 'updates': sh.updates, 'paused': 0.0}
        refill_from = sh.env_steps
        while not sh.stop.is_set():
            now = time.time()
            if not sh.learning:
                self.replay.commit()
                if self.replay.transitions_added >= c.learning_starts and self.replay.can_sample(cfg.sac.n_step):
                    self.publish_policy()
                    sh.learn_steps0, sh.learn_updates0 = sh.env_steps, sh.updates
                    sh.learning = True
                    last['sync'] = last['eval'] = now
                    print(f'learning starts at {sh.env_steps:,} env steps '
                          f'({sh.env_steps - refill_from:,} collected here)', flush=True)
                else:
                    time.sleep(0.01)
            else:
                # the cap counts from the start of learning: no burst of updates on the first transitions
                allowed = int(c.utd * (sh.env_steps - sh.learn_steps0)) - (sh.updates - sh.learn_updates0)
                if allowed >= 1:
                    agent.update(min(k_max, allowed), sh.env_steps)
                    sh.updates = agent.updates
                else:
                    time.sleep(0.001)
                if now - last['sync'] >= c.actor_sync_secs:
                    self.publish_policy()
                    last['sync'] = now
                if self.eval and now - last['eval'] >= cfg.eval.every_secs:
                    ck = self.checkpoint()
                    atomic_save(ck, self.run_dir / 'latest.pt')
                    self.eval.submit(ck)
                    last['eval'] = now
            if now - last['log'] >= cfg.log_every_secs:
                self.log(prev)
                last['log'] = now
            if now - last['ckpt'] >= cfg.checkpoint_every_secs:
                atomic_save(self.checkpoint(), self.run_dir / f'ckpt-{sh.env_steps:010d}.pt')
                last['ckpt'] = now
            if cfg.max_env_steps and sh.env_steps >= cfg.max_env_steps:
                break

    def log(self, prev: dict) -> None:
        sh = self.shared
        now = time.time()
        dt = max(now - prev['t'], 1e-9)
        d_steps, d_upd = sh.env_steps - prev['steps'], sh.updates - prev['updates']
        paused = self.collector.paused_secs
        line: dict[str, Any] = {
            'time': now, 'wall_secs': round(self.start_wall + now - self.t0, 1), 'env_steps': sh.env_steps,
            'updates': sh.updates, 'steps_per_sec': round(d_steps / dt, 1), 'updates_per_sec': round(d_upd / dt, 1),
            'utd': round(d_upd / d_steps, 3) if d_steps else None,
            'utd_since_learning': round(sh.utd_since_start(), 3) if sh.learning and sh.env_steps > sh.learn_steps0
            else None,
            'collector_paused': round((paused - prev['paused']) / dt, 3),
            'buffer': self.replay.size(), 'learning': sh.learning,
        }
        line.update({k: round(v, 5) for k, v in self.agent.read_metrics().items()})
        with self.collector.stats_lock:
            line.update(self.collector.episodes.drain())
        if self.device_is_cuda():
            line['gpu_mem_gb'] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 2)
        prev.update(t=now, steps=sh.env_steps, updates=sh.updates, paused=paused)
        with open(self.run_dir / 'train.jsonl', 'a') as f:
            f.write(json.dumps(line, default=_json_default) + '\n')
        brief = (f"[{line['wall_secs']:>7.0f}s] steps {sh.env_steps:>10,} ({line['steps_per_sec']:.0f}/s)  "
                 f"updates {sh.updates:>10,} ({line['updates_per_sec']:.0f}/s, utd {line['utd']})")
        if 'critic_loss' in line:
            brief += (f"  closs {line['critic_loss']:.3f}  q {line['q_mean']:.1f}  alpha {line.get('alpha', 0):.4f}"
                      f"  ent {line.get('entropy', 0):.2f}")
            if any(self.cfg.sac.rate_reg):
                brief += f"  rate {line.get('action_rate', 0):.4f}"
        if line.get('episodes'):
            brief += f"  eps {line['episodes']} ret {line['ep_return']:.1f}"
            if 'ep_progress' in line:
                brief += f" prog {line['ep_progress']:.0f} m  ends {line['ends']}"
        if line.get('laps'):
            brief += f"  laps {line['laps_valid']}/{line['laps']} best {line['lap_best_valid']}"
        print(brief, flush=True)

    def device_is_cuda(self) -> bool:
        return self.agent.device.type == 'cuda'

    def shutdown(self, save: bool = True) -> None:
        sh = self.shared
        sh.stop.set()
        self.collector.join(timeout=30)
        if self.eval:
            self.eval.join(timeout=120)
        if save:
            atomic_save(self.checkpoint(), self.run_dir / 'latest.pt')
        self.pool.close()


def run(cfg: TrainConfig, run_dir: Path, make_pool: Callable[[TrainConfig], Any], evaluate: Evaluator | None,
        resume: bool = False) -> Trainer:
    """Trains until max_env_steps, SIGINT/SIGTERM or a failure in any thread (raised here after a clean shutdown,
    with the traceback also in train.jsonl)."""
    torch.set_num_threads(1)  # the collector's CPU actor and the evaluator: the cores belong to the env workers
    trainer = Trainer(cfg, run_dir, make_pool, evaluate, resume)
    sh = trainer.shared
    handlers = {}
    if threading.current_thread() is threading.main_thread():
        def on_signal(signum, _frame):
            print(f'\nsignal {signal.Signals(signum).name}: stopping', flush=True)
            sh.stop.set()
        handlers = {s: signal.signal(s, on_signal) for s in (signal.SIGINT, signal.SIGTERM)}
    failed = False
    try:
        trainer.run()
    except BaseException:  # noqa: BLE001
        sh.fail('learner')
    finally:
        failed = bool(sh.errors)
        try:
            trainer.shutdown(save=True)
        except BaseException:  # noqa: BLE001
            sh.errors.append(f'shutdown:\n{traceback.format_exc()}')
        for s, h in handlers.items():
            signal.signal(s, h)
    if sh.errors:
        with open(run_dir / 'train.jsonl', 'a') as f:
            f.write(json.dumps({'time': time.time(), 'error': sh.errors}) + '\n')
        raise RuntimeError('training failed:\n' + '\n'.join(sh.errors))
    print(f'stopped at {sh.env_steps:,} env steps, {sh.updates:,} updates; saved {run_dir / "latest.pt"}'
          + (' (after a failure)' if failed else ''), flush=True)
    return trainer


def env_combos(cfg: TrainConfig) -> list[tuple[str, str]]:
    """Every (track, car) the run trains on: env.reset.tracks x cars (the env's defaults where the config is silent)."""
    reset = cfg.env.get('reset', {})
    return [(t, c) for t in reset.get('tracks', ['melbourne']) for c in reset.get('cars', ['lcf1'])]


def make_env_pool(cfg: TrainConfig, worker: str | None = None):
    from envpool import EnvPool
    env = cfg.env if cfg.reward is None else merge(cfg.env, {'reward': ENV_REWARD})
    return EnvPool(cfg.collect.num_workers, cfg.collect.envs_per_worker, env, seed=cfg.seed, worker_path=worker)


def lap_evaluator(cfg: TrainConfig, worker: str | None = None) -> Evaluator:
    from evaluate import evaluate_laps

    def evaluate(act_fn) -> tuple[list[dict], float]:
        e = cfg.eval
        base = [tuple(c) for c in e.combos] or env_combos(cfg)
        combos = [c for c in base for _ in range(e.repeats)]
        noise = [e.noise if k else 0.0 for _ in base for k in range(e.repeats)]
        res = evaluate_laps(act_fn, combos, config=cfg.env, num_workers=e.num_workers, seed=cfg.seed + 7, noise=noise,
                            worker_path=worker, laps=e.laps)
        # the score to minimise: each combo's mean lap time over its repeats, a lap that is not clean counting as
        # invalid_lap_secs, so more clean laps always beats a faster lap
        clean = lambda r: r['lap_valid'] and r['lap_time'] is not None and not r['wall_contact_steps']
        score = sum(r['lap_time'] if clean(r) else e.invalid_lap_secs for r in res) / e.repeats
        return res, float(score)

    return evaluate


def run_worker(run_dir: Path) -> str:
    """The run's own copy of the env worker (made when the run begins): a rebuild of build/env/worker.mjs while the
    run goes on must not change the environment under it, nor break the evaluations, which start workers each time."""
    from envpool import WORKER
    dst = run_dir / 'worker.mjs'
    if not dst.exists():
        run_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(WORKER, dst)
    return str(dst)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--name', required=True, help='run folder name under ai/rl/runs/')
    ap.add_argument('--config', help='JSON file with config overrides')
    ap.add_argument('--set', action='append', default=[], metavar='KEY=VALUE', help='override, e.g. sac.gamma=0.99')
    ap.add_argument('--resume', action='store_true', help="continue the run from its latest.pt (its config.json "
                                                          "is the base, --config / --set apply on top)")
    args = ap.parse_args(argv)
    run_dir = RUNS / args.name
    if args.resume:
        base = json.loads((run_dir / 'config.json').read_text())
        cfg = load_config(args.config, args.set, base=base)
    else:
        if (run_dir / 'latest.pt').exists():
            sys.exit(f'{run_dir} already has a run: pass --resume, or choose another --name')
        cfg = load_config(args.config, args.set)
    try:
        worker = run_worker(run_dir)
        run(cfg, run_dir, lambda c: make_env_pool(c, worker), lap_evaluator(cfg, worker), resume=args.resume)
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
