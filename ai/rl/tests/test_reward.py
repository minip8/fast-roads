"""The trainer's reward (reward.py) from an info block: each term, by hand."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reward import ENV_REWARD, Shaper  # noqa: E402

FIELDS = ['reward_progress', 'reward_terminal', 'reward_smooth', 'speed', 'off_track_time', 'pit_lane_time',
          'wall_contact', 'wall_hit']
IX = {k: i for i, k in enumerate(FIELDS)}


def row(**v):
    r = np.zeros(len(FIELDS))
    for k, x in v.items():
        r[IX[k]] = x
    return r


def test_terms():
    sh = Shaper(IX, 0.05)
    info = np.stack([
        row(reward_progress=3.0, speed=60.0),                       # clean: the progress only
        row(speed=-60.0, off_track_time=0.05),                      # off the track: -2 x 60 x 0.05 (|speed|)
        row(speed=60.0, pit_lane_time=0.03),                        # in the pit lane, as off the track
        row(reward_progress=1.0, speed=20.0, wall_contact=1, wall_hit=4.0, reward_terminal=-20.0),
    ])
    np.testing.assert_allclose(sh(info), [3.0, -6.0, -3.6, 1 - 3 * 20 * 0.05 - 4 - 20], rtol=1e-6)
    assert Shaper(IX, 0.05, {'pit_lane': 0})(info)[2] == 0


def test_env_penalties_off_and_an_old_worker_refused():
    assert ENV_REWARD['pitLane'] == 0 and ENV_REWARD['offTrack'] == 0
    with pytest.raises(ValueError, match='pit_lane_time'):
        Shaper({k: i for i, k in enumerate(FIELDS) if k != 'pit_lane_time'}, 0.05)
    with pytest.raises(ValueError, match='unknown'):
        Shaper(IX, 0.05, {'pit': 1})


def test_events_once_per_excursion_and_episode():
    sh = Shaper(IX, 0.05, {'off_event': 2.0, 'pit_event': 2.0, 'wall_event': 1.0, 'off_track': 0, 'pit_lane': 0,
                           'wall_contact': 0, 'wall_hit': 0})
    off = np.stack([row(speed=50.0, off_track_time=0.01), row(speed=40.0, wall_contact=1), row(speed=30.0)])
    np.testing.assert_allclose(sh(off), [-100.0, -40.0, 0.0])             # the excursion begins: seconds x speed
    np.testing.assert_allclose(sh(off), [0.0, 0.0, 0.0])                  # it goes on: nothing more
    np.testing.assert_allclose(sh(np.stack([row(speed=50.0)] * 3)), 0.0)  # back on
    np.testing.assert_allclose(sh(off, np.array([0])), [-100.0, -40.0, 0.0])   # again; env 0's episode ends here
    np.testing.assert_allclose(sh(off), [-100.0, 0.0, 0.0])               # its new episode pays for its own
    pit = np.stack([row(speed=20.0, pit_lane_time=0.05)] * 3)
    np.testing.assert_allclose(Shaper(IX, 0.05, {'pit_event': 2.0, 'pit_lane': 0})(pit), -40.0)


def test_rate_terms_charge_the_absolute_change_of_the_action():
    sh = Shaper(IX, 0.05, {'steer_rate': 2.0, 'pedal_rate': 0.5}, {'prev_steer': 1, 'prev_pedal': 3})
    obs = np.zeros((2, 5), np.float32)
    obs[:, 1], obs[:, 3] = [0.1, -0.2], [1.0, 0.0]
    actions = np.array([[0.15, 1.3], [0.2, -0.5]], np.float32)   # (the pedal's 1.3 reaches the env as 1)
    info = np.stack([row(reward_progress=3.0, speed=50.0)] * 2)
    np.testing.assert_allclose(sh(info, None, obs, actions), [3 - 2 * 0.05 - 0, 3 - 2 * 0.4 - 0.5 * 0.5], rtol=1e-5)
    with pytest.raises(ValueError, match='observation index'):
        Shaper(IX, 0.05, {'steer_rate': 1.0})
