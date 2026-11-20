"""The full training loop solves Pendulum-v1 (sanity_pendulum.py). Takes a few minutes: `pytest -m sanity`."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.mark.sanity
def test_pendulum_is_solved():
    from sanity_pendulum import sanity
    out = sanity(20_000, name='sanity-pendulum-test')
    assert out['final_mean_return'] > -200, out
