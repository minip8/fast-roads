"""Evaluation laps: one evaluation episode (the game's flying start, ending when the first timed lap is complete) per
(track, car), all run concurrently over an EnvPool, compared with the autopilot's pinned laps (test/laps.ts).

    python evaluate.py --autopilot --tracks melbourne,silverstone --cars lcf1,lcgt3,drift
    python evaluate.py --checkpoint runs/x/policy.pt --tracks all --cars lcf1
"""
from __future__ import annotations

import argparse
import copy
import math
import os
import re
import sys
import time
from typing import Callable

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envpool import EnvPool  # noqa: E402

ActFn = Callable[[np.ndarray], np.ndarray]
LAPS_TS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'test', 'laps.ts'))
DEFAULT_EVAL_CONFIG: dict = {'tc': True, 'cacheSessions': 1}


def load_policy(path: str) -> ActFn:
    """A deterministic act_fn(obs [n, D] f32) -> [n, 2] f32 from a training checkpoint (.pt) or an exported .npz."""
    from sac import load_act_fn
    return load_act_fn(path)


def pinned_laps(path: str = LAPS_TS) -> dict[tuple[str, str], float]:
    """The autopilot's pinned lap times with TC on, {(track, car): seconds}, parsed from test/laps.ts."""
    src = open(path, encoding='utf-8').read()
    laps: dict[tuple[str, str], float] = {}
    for m in re.finditer(r"track:\s*'(\w+)',\s*car:\s*'(\w+)',\s*tc:\s*(true|false),\s*time:\s*'([\d.]+)'", src):
        if m.group(3) == 'true':
            laps[(m.group(1), m.group(2))] = float(m.group(4))
    cal = re.search(r'const CALENDAR[^=]*=\s*\{(.*?)\n\};', src, re.S)
    if cal:
        for m in re.finditer(r'^\s*(\w+):\s*\{([^}]*)\}', cal.group(1), re.M):
            for car, t in re.findall(r"(\w+):\s*'([\d.]+)'", m.group(2)):
                laps[(m.group(1), car)] = float(t)
    return laps


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


def evaluate_laps(act_fn: ActFn | None, combos: list[tuple[str, str]], *, config: dict | None = None,
                  num_workers: int = 1, max_steps: int | None = None, seed: int = 0) -> list[dict]:
    """One evaluation episode per (track, car) combo; act_fn None = the autopilot. Returns one dict per combo."""
    combos = [(str(t), str(c)) for t, c in combos]
    if not combos:
        return []
    n = len(combos)
    epw = math.ceil(n / max(1, num_workers))
    workers = math.ceil(n / epw)   # no more workers than needed; the last one may carry idle padding envs
    cfg = _merge(DEFAULT_EVAL_CONFIG, config or {})
    reset_cfg = cfg.setdefault('reset', {})
    for key, vals in (('tracks', [t for t, _ in combos]), ('cars', [c for _, c in combos])):
        have = list(reset_cfg.get(key, []))
        reset_cfg[key] = have + [v for v in dict.fromkeys(vals) if v not in have]
    reset_cfg['eval'] = True
    total = workers * epw
    slots = combos + [combos[0]] * (total - n)   # padding envs drive combo 0 and are ignored

    results = [dict(track=t, car=c, lap_time=None, lap_valid=False, end_reason='unfinished', steps=0,
                    episode_time=0.0, wall_contact_steps=0, max_wall_hit=0.0, off_track_time=0.0,
                    min_speed=math.inf, mean_speed=0.0, reward_sum=0.0) for t, c in combos]
    with EnvPool(workers, epw, cfg, seed=seed) as pool:
        ix = pool.info_index
        obs, _ = pool.reset([{'eval': True, 'track': t, 'car': c, 'start': 'flying'} for t, c in slots])
        active = np.zeros(total, bool)
        active[:n] = True
        speed_sum = np.zeros(n)
        actions = np.full((total, 2), np.nan, np.float32)
        steps = 0
        while active.any() and (max_steps is None or steps < max_steps):
            actions[:] = np.nan
            if act_fn is not None:
                idx = np.flatnonzero(active)
                actions[idx] = np.asarray(act_fn(obs[idx]), np.float32).reshape(len(idx), 2)
            r = pool.step(actions)
            steps += 1
            info = r.info
            for g in np.flatnonzero(active):
                row, res = info[g], results[g]
                res['steps'] += 1
                res['episode_time'] = float(row[ix['episode_time']])
                res['wall_contact_steps'] += int(row[ix['wall_contact']] > 0)
                res['max_wall_hit'] = max(res['max_wall_hit'], float(row[ix['wall_hit']]))
                res['off_track_time'] += float(row[ix['off_track_time']])
                sp = float(row[ix['speed']])
                res['min_speed'] = min(res['min_speed'], sp)
                speed_sum[g] += sp
                res['reward_sum'] += float(r.reward[g])
                if row[ix['lap_done']] > 0 and res['lap_time'] is None:
                    res['lap_time'] = float(row[ix['lap_time']])
                    res['lap_valid'] = bool(row[ix['lap_valid']] == 1)
            for g in r.done_idx:
                if g < n and active[g]:
                    results[g]['end_reason'] = pool.end_reasons[int(info[g, ix['end_reason']])]
                    active[g] = False
            obs = r.obs
    for g, res in enumerate(results):
        res['mean_speed'] = speed_sum[g] / res['steps'] if res['steps'] else 0.0
        if res['min_speed'] == math.inf:
            res['min_speed'] = 0.0
    return results


def _fmt(v: float | None, spec: str = '.3f') -> str:
    return '-' if v is None else format(v, spec)


def print_table(results: list[dict], pinned: dict[tuple[str, str], float] | None = None, file=sys.stdout) -> None:
    pinned = pinned_laps() if pinned is None else pinned
    head = f"{'track':<12} {'car':<6} {'lap s':>9} {'valid':>5} {'walls':>5} {'off s':>6} {'pinned':>9} {'diff':>8}  end"
    print(head, file=file)
    print('-' * len(head), file=file)
    for r in results:
        pin = pinned.get((r['track'], r['car']))
        diff = round(r['lap_time'] - pin, 3) + 0.0 if r['lap_time'] is not None and pin is not None else None
        print(f"{r['track']:<12} {r['car']:<6} {_fmt(r['lap_time']):>9} {'yes' if r['lap_valid'] else 'no':>5} "
              f"{r['wall_contact_steps']:>5} {r['off_track_time']:>6.2f} {_fmt(pin):>9} {_fmt(diff, '+.3f'):>8}  "
              f"{r['end_reason']}", file=file)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument('--autopilot', action='store_true', help='drive with the game autopilot (NaN actions)')
    who.add_argument('--checkpoint', help='policy checkpoint, loaded by load_policy()')
    ap.add_argument('--tracks', default='melbourne', help="comma-separated circuit ids, or 'all'")
    ap.add_argument('--cars', default='lcf1', help="comma-separated car ids, or 'all'")
    ap.add_argument('--workers', type=int, default=min(6, os.cpu_count() or 1))
    ap.add_argument('--max-steps', type=int, default=None)
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args(argv)
    pinned = pinned_laps()
    split = lambda s: [x for x in re.split(r'[,\s]+', s) if x]  # noqa: E731
    tracks = sorted({t for t, _ in pinned}) if args.tracks == 'all' else split(args.tracks)
    cars = ['lcf1', 'lcgt3', 'drift'] if args.cars == 'all' else split(args.cars)
    act_fn = None if args.autopilot else load_policy(args.checkpoint)
    t0 = time.time()
    res = evaluate_laps(act_fn, [(t, c) for t in tracks for c in cars], num_workers=args.workers,
                        max_steps=args.max_steps, seed=args.seed)
    print_table(res, pinned)
    print(f'({time.time() - t0:.1f} s wall)')


if __name__ == '__main__':
    main()
