"""Consecutive laps: python stint.py lcgt3 [laps 5] [tracks a,b]

The game's policy for the car at each circuit (public/ai/policies.json) drives on from the flying start for several
laps, as `?autopilot=rl` does in the game (evaluation stops at one): each lap's time and validity, wall contacts, and
whether the episode ended early (stuck, wrong way). Laps after the first start from what the lap before left: speed
over the line, tyres, brakes."""
import json
import sys
from pathlib import Path

import numpy as np

import export_web
from envpool import EnvPool
from evaluate import pinned_laps
from reward import ENV_REWARD

car = sys.argv[1]
laps = int(sys.argv[2]) if len(sys.argv) > 2 else 5
PUBLIC = Path(__file__).resolve().parent.parent.parent / 'public' / 'ai'
manifest = json.loads((PUBLIC / 'policies.json').read_text())[car]
tracks = sys.argv[3].split(',') if len(sys.argv) > 3 else [t for (t, c) in pinned_laps() if c == car]


class WebPolicy:   # the installed file itself, run as policy_np.NumpyPolicy runs an .npz
    def __init__(self, path):
        self.meta, self.a = export_web.unpack(path.read_bytes())

    def __call__(self, obs):
        m, a = self.meta, self.a
        x = np.clip((obs - a['obs_mean']) * a['obs_scale'], -m['obs_clip'], m['obs_clip']).astype(np.float32)
        stack = []
        for op in m['ops']:
            k = op['op']
            if k == 'linear':
                x = x @ a[op['w']] + a[op['b']]
            elif k == 'layernorm':
                x = (x - x.mean(-1, keepdims=True)) / np.sqrt(x.var(-1, keepdims=True) + op['eps']) * a[op['w']] + a[op['b']]
            elif k == 'relu':
                x = np.maximum(x, 0)
            elif k == 'push':
                stack.append(x.copy())
            elif k == 'add':
                x = x + stack.pop()
        n = m['act_dim']
        return np.clip(np.tanh(x[..., :n]) * np.asarray(m.get('act_scale', [1.0] * n), np.float32), -1, 1).astype(np.float32)


policies = [WebPolicy(PUBLIC / manifest.get('tracks', {}).get(t, manifest['default'])) for t in tracks]
env = dict(policies[0].meta['env'])
env.update(episodeSecs=200.0 * laps, cacheSessions=1, reward=ENV_REWARD,
           reset={**env['reset'], 'tracks': tracks, 'cars': [car], 'start': 'flying', 'eval': False})
workers = min(4, len(tracks))
per = -(-len(tracks) // workers)
with EnvPool(workers, per, env, seed=5) as pool:
    ix = pool.info_index
    n = len(tracks)
    slots = tracks + [tracks[0]] * (pool.num_envs - n)
    obs, _ = pool.reset([{'track': t, 'car': car, 'start': 'flying'} for t in slots])
    done = np.zeros(pool.num_envs, bool)
    done[n:] = True
    out = [dict(laps=[], wall=0, end='') for _ in tracks]
    act = np.full((pool.num_envs, 2), np.nan, np.float32)
    while not done.all():
        for g in np.flatnonzero(~done):
            act[g] = policies[g](obs[g])
        act[done] = np.nan
        res = pool.step(act)
        for g in np.flatnonzero(~done):
            row, o = res.info[g], out[g]
            o['wall'] += int(row[ix['wall_contact']] > 0)
            if row[ix['lap_done']] > 0:
                o['laps'].append((float(row[ix['lap_time']]), bool(row[ix['lap_valid']] == 1)))
            if g in res.done_idx or len(o['laps']) >= laps:
                o['end'] = pool.end_reasons[int(row[ix['end_reason']])] if g in res.done_idx else ''
                done[g] = True
        obs = res.obs
bad = 0
for t, o in zip(tracks, out):
    ok = len(o['laps']) == laps and all(v for _, v in o['laps']) and not o['wall']
    bad += not ok
    print(f"{t:<12} " + ' '.join(f"{lt:8.3f}{'' if v else '!'}" for lt, v in o['laps']) + f"  wall {o['wall']}" + (f"  ended {o['end']}" if o['end'] else '') + ('' if ok else '   <<<'))
print(f'{len(tracks) - bad}/{len(tracks)} circuits: {laps} valid laps in a row, no wall contact')
