"""Writes the policy-inference fixtures test/ai-policy.test.ts checks src/ai/policy.ts against: two small policies
with random weights, one per actor the trainer can export (SimBa residual blocks; Linear -> LayerNorm -> ReLU), as
web policy files (export_web.pack), and random observations with the actions numpy gives for them (policy_np.py, the
exported policy's reference runner).

    cd ai/rl && .venv/bin/python tests/make_policy_fixture.py      # -> test/fixtures/policy-*.bin, policy-parity.json

Deterministic (seeded): rerun only when the format or the runner changes. The observation size is the environment's
default (164: OBS_VERSION 3, 16 look-ahead samples), which the game checks a policy file against.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from export_web import pack  # noqa: E402
from policy_np import FORMAT, NumpyPolicy  # noqa: E402

OUT = HERE.parent.parent.parent / 'test' / 'fixtures'
OBS_DIM, ACT_DIM, OBS_VERSION, CLIP = 164, 2, 3, 10.0
# the control part of the environment's defaults (src/ai/config.ts DEFAULT_CONFIG) as a policy file carries it
ENV = {'actionHz': 20, 'actionMode': 'absolute', 'deltaScale': [0.25, 0.5], 'steerRate': 3, 'pedalRate': 0, 'tc': True,
       'obs': {'lookahead': 16, 'lookMinM': 40, 'lookSecs': 4, 'lookPow': 1.5}}


def build(kind: str, rng: np.random.Generator) -> tuple[dict, dict[str, np.ndarray]]:
    """meta and arrays as sac.actor_arrays names and orders them."""
    arrays: dict[str, np.ndarray] = {}
    ops: list[dict] = []

    def lin(i: int, o: int, gain: float = 1.0) -> None:
        k = len(arrays) // 2
        arrays[f'w{k}'] = (rng.standard_normal((i, o)) * gain / np.sqrt(i)).astype(np.float32)
        arrays[f'b{k}'] = (rng.standard_normal(o) * 0.1).astype(np.float32)
        ops.append({'op': 'linear', 'w': f'w{k}', 'b': f'b{k}'})

    def ln(n: int) -> None:
        k = len(arrays) // 2
        arrays[f'ln{k}_w'] = (1 + 0.2 * rng.standard_normal(n)).astype(np.float32)
        arrays[f'ln{k}_b'] = (0.1 * rng.standard_normal(n)).astype(np.float32)
        ops.append({'op': 'layernorm', 'w': f'ln{k}_w', 'b': f'ln{k}_b', 'eps': 1e-5})

    if kind == 'simba':
        h = 16
        lin(OBS_DIM, h)
        for _ in range(2):
            ops.append({'op': 'push'})
            ln(h)
            lin(h, 4 * h)
            ops.append({'op': 'relu'})
            lin(4 * h, h)
            ops.append({'op': 'add'})
        ln(h)
        last = h
    else:
        dims = [OBS_DIM, 24, 16]
        for i, o in zip(dims, dims[1:]):
            lin(i, o)
            ln(o)
            ops.append({'op': 'relu'})
        last = dims[-1]
    lin(last, 2 * ACT_DIM, gain=0.8)   # gain: the actions mostly inside tanh's slope, not saturated
    arrays['obs_mean'] = (0.3 * rng.standard_normal(OBS_DIM)).astype(np.float32)
    arrays['obs_scale'] = np.exp(0.5 * rng.standard_normal(OBS_DIM)).astype(np.float32)
    meta = {'format': FORMAT, 'version': 1, 'obs_dim': OBS_DIM, 'act_dim': ACT_DIM, 'obs_clip': CLIP, 'ops': ops,
            'output': f'first {ACT_DIM} outputs: Gaussian mean; action = clamp(act_scale x tanh(mean), -1, 1)'}
    if kind == 'simba':   # one fixture with an action scale (its pedal reaches the clamp), one without the key
        meta['act_scale'] = [1.0, 1.6]
    return meta, arrays


def main() -> None:
    rng = np.random.default_rng(20261120)
    OUT.mkdir(parents=True, exist_ok=True)
    obs = np.clip(rng.standard_normal((20, OBS_DIM)) * 2, -10, 10).astype(np.float32)
    obs[:, :3] = [1, 0, 0]         # a car one-hot, and some exact zeros (flags), as real observations have
    obs[::3, 15:40] = 0
    obs[5, 50:60] = 12             # past the clip
    parity = {'obs': obs.tolist()}
    for kind in ('simba', 'mlp'):
        meta, arrays = build(kind, rng)
        buf = io.BytesIO()
        np.savez(buf, meta=np.array(json.dumps(meta)), **arrays)
        buf.seek(0)
        actions = NumpyPolicy(buf)(obs)
        assert np.mean(np.abs(actions) < 0.999) > 0.6, 'saturated fixture'   # (the scaled pedal clamps in some)
        web = pack(dict(meta, obsVersion=OBS_VERSION, env=ENV, trained={'cars': ['lcf1', 'lcgt3', 'drift'], 'tracks': ['melbourne']},
                        provenance={'fixture': f'make_policy_fixture.py {kind}, random weights'}), arrays)
        (OUT / f'policy-{kind}.bin').write_bytes(web)
        parity[kind] = actions.astype(np.float64).tolist()   # float32 values, exact as doubles
        print(f'{OUT / f"policy-{kind}.bin"}: {len(web):,} bytes; actions {actions.min():.3f}..{actions.max():.3f}')
    (OUT / 'policy-parity.json').write_text(json.dumps(parity, separators=(',', ':')) + '\n')
    print(f'{OUT / "policy-parity.json"}: {os.path.getsize(OUT / "policy-parity.json"):,} bytes')


if __name__ == '__main__':
    main()
