"""What changes over consecutive laps: python stint_trace.py <policy .npz | autopilot> <track> <car> [seconds 330]
Every 15 s: lap position, speed, the four tyres' temperature observations (0 = bottom of the working window, 1 = top),
the mean of the wheels' slip, and the laps as they complete."""
import sys

import numpy as np

from envpool import EnvPool
from evaluate import load_policy
from reward import ENV_REWARD

src, track, car = sys.argv[1], sys.argv[2], sys.argv[3]
secs = float(sys.argv[4]) if len(sys.argv) > 4 else 330
act = None if src == 'autopilot' else load_policy(src)
cfg = {'reward': ENV_REWARD, 'cacheSessions': 1, 'episodeSecs': secs, 'reset': {'tracks': [track], 'cars': [car], 'start': 'flying'}}
with EnvPool(1, 1, cfg) as pool:
    ix, ox = pool.info_index, pool.obs_index
    obs, _ = pool.reset({'track': track, 'car': car, 'start': 'flying'})
    ty = [ox[f'tyre_{w}_temp'] for w in ('fl', 'fr', 'rl', 'rr')]
    sl = [ox[f'wheel_{w}_slip'] for w in ('fl', 'fr', 'rl', 'rr')]
    k, slip = 0, []
    while True:
        a = np.full((1, 2), np.nan, np.float32) if act is None else act(obs)
        res = pool.step(a)
        info = res.info[0]
        slip.append(obs[0, sl].mean())
        if info[ix['lap_done']] > 0:
            print(f"   lap {info[ix['lap_time']]:.3f} {'valid' if info[ix['lap_valid']] == 1 else 'INVALID'}")
        if k % 300 == 0:
            print(f"{info[ix['episode_time']]:6.0f} s  s {info[ix['lap_s']]:5.0f}  {info[ix['speed']] * 3.6:4.0f} km/h  tyres "
                  + ' '.join(f'{obs[0, i]:5.2f}' for i in ty) + f"  slip {np.mean(slip):.2f}")
            slip = []
        k += 1
        if len(res.done_idx):
            print('ended:', pool.end_reasons[int(info[ix['end_reason']])])
            break
        obs = res.obs
