"""A trained policy as plain arrays (`.npz`) and a pure-numpy runner for it: what the browser port will mirror.

File layout (`np.load(path)`; every array float32 except `meta`):
- `meta`: a 0-d unicode array holding a JSON object:
    {"format": "fast-roads-policy", "version": 1, "obs_dim": D, "act_dim": A, "obs_clip": 10,
     "ops": [...], "output": "..."}
- `obs_mean` [D], `obs_scale` [D]: the observation normaliser; x = clip((obs - obs_mean) * obs_scale, -obs_clip,
  obs_clip) (mean 0, scale 1 when the run had no normaliser).
- one array per weight named in `ops`: linear weights are [in, out] (y = x @ w + b), biases and LayerNorm
  parameters [out].

`ops` run in order on a vector x (starting as the normalised obs), with a stack for residual connections:
- {"op": "linear", "w": name, "b": name}           x = x @ w + b
- {"op": "layernorm", "w": name, "b": name, "eps"}  x = (x - mean(x)) / sqrt(var(x) + eps) * w + b (biased var)
- {"op": "relu"}                                    x = max(x, 0)
- {"op": "push"}                                    push a copy of x
- {"op": "add"}                                     x = x + pop()
The final x has 2A values: the first A are the Gaussian mean, the action is clamp(act_scale x tanh(mean), -1, 1) (the
deterministic policy; `act_scale` [A] in meta, 1 each if absent; the other A are the log-std's pre-activation, unused
here).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

FORMAT = 'fast-roads-policy'


class NumpyPolicy:
    def __init__(self, path: str | Path):
        with np.load(path, allow_pickle=False) as z:
            self.meta = json.loads(str(z['meta']))
            self.arrays = {k: z[k].astype(np.float32) for k in z.files if k != 'meta'}
        if self.meta.get('format') != FORMAT:
            raise ValueError(f'{path}: not a {FORMAT} file')
        self.obs_dim, self.act_dim = self.meta['obs_dim'], self.meta['act_dim']

    def __call__(self, obs: np.ndarray) -> np.ndarray:
        """obs [n, D] (or [D]) -> deterministic actions [n, A] (or [A]), float32."""
        a = self.arrays
        x = np.asarray(obs, dtype=np.float32)
        clip = self.meta['obs_clip']
        x = np.clip((x - a['obs_mean']) * a['obs_scale'], -clip, clip)
        stack = []
        for op in self.meta['ops']:
            kind = op['op']
            if kind == 'linear':
                x = x @ a[op['w']] + a[op['b']]
            elif kind == 'layernorm':
                mu = x.mean(-1, keepdims=True)
                var = ((x - mu) ** 2).mean(-1, keepdims=True)
                x = (x - mu) / np.sqrt(var + op['eps']) * a[op['w']] + a[op['b']]
            elif kind == 'relu':
                x = np.maximum(x, 0)
            elif kind == 'push':
                stack.append(x.copy())
            elif kind == 'add':
                x = x + stack.pop()
            else:
                raise ValueError(f'unknown op {kind!r}')
        scale = np.asarray(self.meta.get('act_scale', [1.0] * self.act_dim), np.float32)
        return np.clip(np.tanh(x[..., :self.act_dim]).astype(np.float32) * scale, -1, 1)
