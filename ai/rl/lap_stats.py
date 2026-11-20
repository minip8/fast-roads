"""How a traced lap (trace_lap.py's .npz) was driven: python lap_stats.py runs/traces/x.npz [...]

Pedal shares, grip use (wheel slip: 1 = the tyre's peak), how much the steering command moves from step to step and
how often it reverses (a policy that flips it every step is using the env's slew limit as a filter: bang-bang), aids."""
import sys

import numpy as np

for path in sys.argv[1:]:
    z = np.load(path)
    I, O, f, n = z['info'], z['obs'], list(z['info_fields']), list(z['obs_names'])
    o = lambda k: O[:, n.index(k)]
    slip = np.stack([o(f'wheel_{w}_slip') for w in ('fl', 'fr', 'rl', 'rr')], 1).max(1)
    thr, brk, ts, tp = o('throttle'), o('brake'), o('target_steer'), o('target_pedal')
    d = np.diff(ts)
    flips = int((np.sign(d[1:]) * np.sign(d[:-1]) < 0).sum())
    lap = I[-1, f.index('lap_time')]
    print(f"{path}: lap {lap:.3f}  steps {len(I)}\n"
          f"  throttle full {100 * (thr > 0.95).mean():.0f}%  part {100 * ((thr >= 0.05) & (thr <= 0.95)).mean():.0f}%"
          f"  brake {100 * (brk > 0.05).mean():.0f}%  coast {100 * ((thr < 0.05) & (brk < 0.05)).mean():.0f}%\n"
          f"  slip mean {slip.mean():.2f}  over the peak {100 * (slip > 1).mean():.0f}% of steps"
          f"  tc {100 * o('tc_active').mean():.0f}%  abs {100 * o('abs_active').mean():.0f}%\n"
          f"  steer command: mean |change| {np.abs(d).mean():.4f} per step, {flips} reversals"
          f"  pedal command: mean |change| {np.abs(np.diff(tp)).mean():.4f}\n"
          f"  battery min {o('battery').min():.2f}  flaps open {100 * o('flaps_open').mean():.0f}%")
