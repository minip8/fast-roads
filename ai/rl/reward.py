"""The training reward, composed in the trainer from the environment's per-step info (docs/ai-env.md, Info).

The environment's own wall and off-track penalties are fixed amounts per step or second. Fixed penalties are known to
give either wall-riding or a timid car (Fuchs et al. 2021; GT Sophy, Wurman et al. 2022): what works is a penalty that
grows with speed, so it stays in proportion to the progress a mistake could buy. So the trainer turns the env's
penalties off (ENV_REWARD) and builds its own from info:

    progress   reward_progress: centreline metres this step, already 0 while all four wheels are off or the car is in
               the pit lane (the env's rule)
    off track  -off_track x |speed| x seconds of the step with all four wheels off   (x metres the car covered there)
    pit lane   -pit_lane x |speed| x seconds of the step in the pit lane (the game deletes the lap, as off the track)
    wall       -wall_contact x |speed| x step seconds while touching a wall, -wall_hit x impact speed (m/s)
    terminal   reward_terminal: the env's own, on a termination

With off_track = 2 a car off the track loses the progress it would have made and twice that again; pit_lane = 2 the
same in the pit lane (its open entry and exit are asphalt inside the track limits: nothing else marks them).
"""
from __future__ import annotations

import numpy as np

# The env reward config to train with: progress and the terminal penalty only (the rest is composed here).
ENV_REWARD = {'progress': 1.0, 'wallHit': 0.0, 'wallContact': 0.0, 'offTrack': 0.0, 'pitLane': 0.0}

DEFAULTS = {'off_track': 2.0, 'pit_lane': 2.0, 'wall_contact': 3.0, 'wall_hit': 1.0}


class Shaper:
    """shape(info) -> float32 [N] reward, from an EnvPool's info block."""

    def __init__(self, info_index: dict[str, int], step_secs: float, coef: dict | None = None):
        unknown = set(coef or {}) - set(DEFAULTS)
        if unknown:
            raise ValueError(f'unknown reward coefficients {sorted(unknown)}')
        c = {**DEFAULTS, **(coef or {})}
        self.off, self.pit, self.wall, self.hit = c['off_track'], c['pit_lane'], c['wall_contact'], c['wall_hit']
        self.dt = step_secs
        ix = info_index
        if 'pit_lane_time' not in ix:
            raise ValueError('the env worker has no pit_lane_time info (built before the pit lane was observed): npm run build:env')
        self.i = [ix[k] for k in ('reward_progress', 'reward_terminal', 'reward_smooth', 'speed', 'off_track_time',
                                  'pit_lane_time', 'wall_contact', 'wall_hit')]

    def __call__(self, info: np.ndarray) -> np.ndarray:
        prog, term, smooth, speed, off_t, pit_t, contact, hit = (info[:, i] for i in self.i)
        v = np.abs(speed)
        r = (prog + term + smooth - self.off * off_t * v - self.pit * pit_t * v - self.wall * contact * v * self.dt
             - self.hit * hit)
        return r.astype(np.float32)
