"""One evaluation lap, traced: python trace_lap.py <policy .npz/.pt | autopilot> [track] [car] [out.npz] [noise sigma]

Prints where the lap lost its validity, wall contacts and off-track stretches, and saves the per-step info block
(columns: info_fields) and observations for analysis."""
import sys

import numpy as np

from envpool import EnvPool
from evaluate import load_policy
from reward import ENV_REWARD

src = sys.argv[1]
track = sys.argv[2] if len(sys.argv) > 2 else 'melbourne'
car = sys.argv[3] if len(sys.argv) > 3 else 'lcf1'
out = sys.argv[4] if len(sys.argv) > 4 else ''
sigma = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
act = None if src == 'autopilot' else load_policy(src)
rng = np.random.default_rng(0)
with EnvPool(1, 1, {'reward': ENV_REWARD, 'cacheSessions': 1, 'reset': {'tracks': [track], 'cars': [car], 'eval': True}}) as pool:
    ix = pool.info_index
    obs, info = pool.reset({'eval': True, 'track': track, 'car': car})
    infos, obss = [], []
    while True:
        a = np.full((1, 2), np.nan, np.float32) if act is None else act(obs)
        if sigma and act is not None:
            a = np.clip(a + rng.normal(0, sigma, a.shape).astype(np.float32), -1, 1)
        res = pool.step(a)
        infos.append(res.info[0]); obss.append(obs[0])
        obs = res.obs
        if len(res.done_idx):
            break
    I = np.array(infos)
    col = lambda name: I[:, ix[name]]
    valid, s, lat, v = col('lap_valid_now'), col('lap_s'), col('lat'), col('speed') * 3.6
    print(f"{track}/{car}: lap {I[-1, ix['lap_time']]:.3f} valid {I[-1, ix['lap_valid']]} end {pool.end_reasons[int(I[-1, ix['end_reason']])]}"
          f"  steps {len(I)}  top {v.max():.0f} km/h  min {v.min():.0f} km/h")
    for k in range(1, len(I)):
        if valid[k] == 0 and valid[k - 1] != 0:
            print(f"  lap invalid at step {k}: s {s[k]:.0f} m  lat {lat[k]:+.2f} m  {v[k]:.0f} km/h  off_track_time {col('off_track_time')[k]:.3f}")
    off = col('off_track_time') > 0
    for k in np.flatnonzero(off & ~np.r_[False, off[:-1]]):
        n = int(np.argmin(off[k:])) or len(off) - k
        print(f"  off track from step {k}: s {s[k]:.0f} m  lat {lat[k]:+.2f} m  {v[k]:.0f} km/h for {col('off_track_time')[k:k + n].sum():.2f} s")
    wc = col('wall_contact') > 0
    for k in np.flatnonzero(wc & ~np.r_[False, wc[:-1]]):
        print(f"  wall contact from step {k}: s {s[k]:.0f} m  lat {lat[k]:+.2f} m  {v[k]:.0f} km/h  hit {col('wall_hit')[k]:.1f} m/s")
    if out:
        np.savez_compressed(out, info=I, obs=np.array(obss), info_fields=np.array(pool.info_fields),
                            obs_names=np.array([e['name'] for e in pool.obs_spec]))
