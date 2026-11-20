"""Actor, batched quantile-critic ensemble and observation normalisation.

Trunks (actor and critic alike), from `NetConfig`:
- 'simba' (SimBa, Lee et al. 2024): Linear(in, h) -> `blocks` x [x + Linear(4h, h)(ReLU(Linear(h, 4h)(LN(x))))]
  -> LN.
- 'mlp': per width w in `mlp_layers`: Linear -> LN -> ReLU.

The critic ensemble keeps each layer's weights stacked over critics ([C, in, out]) and runs every critic in one
`baddbmm` per layer, so C critics cost one set of kernels.
"""
from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from config import NetConfig

LOG_STD_MIN, LOG_STD_MAX = -5.0, 2.0
OBS_CLIP = 10.0


# ---- observation normalisation ------------------------------------------------------------------------------------

class RunningStats:
    """Running mean / variance (Chan et al.'s parallel merge, float64) of the collected observations.

    `std()` floors the standard deviation at `floor`: the env already scales every element to O(1), so a std below
    the floor means a constant input (a one-hot of the only car trained on, `battery_present`) or a rare binary one
    (`wall_contact`, `off_track`). Constant inputs then normalise to exactly 0, and a rare binary's departure is
    amplified at most 1/floor (20x at 0.05) before the +-10 clip, a strong but bounded signal instead of a blow-up."""

    def __init__(self, dim: int, floor: float):
        self.count = 0.0
        self.mean = np.zeros(dim)
        self.m2 = np.zeros(dim)
        self.floor = floor

    def update(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float64).reshape(-1, self.mean.shape[0])
        n = x.shape[0]
        if n == 0:
            return
        mean = x.mean(0)
        m2 = ((x - mean) ** 2).sum(0)
        total = self.count + n
        delta = mean - self.mean
        self.mean = self.mean + delta * (n / total)
        self.m2 = self.m2 + m2 + delta ** 2 * (self.count * n / total)
        self.count = total

    def std(self) -> np.ndarray:
        var = self.m2 / max(self.count, 1.0)
        return np.maximum(np.sqrt(var), self.floor)

    def state_dict(self) -> dict:
        return {'count': self.count, 'mean': self.mean.copy(), 'm2': self.m2.copy(), 'floor': self.floor}

    def load_state_dict(self, d: dict) -> None:
        self.count, self.mean, self.m2, self.floor = d['count'], d['mean'].copy(), d['m2'].copy(), d['floor']


def normalize(obs: torch.Tensor, mean: torch.Tensor, inv_std: torch.Tensor) -> torch.Tensor:
    return torch.clamp((obs - mean) * inv_std, -OBS_CLIP, OBS_CLIP)


# ---- actor ---------------------------------------------------------------------------------------------------------

class Block(nn.Module):
    def __init__(self, h: int):
        super().__init__()
        self.norm = nn.LayerNorm(h)
        self.fc1 = nn.Linear(h, 4 * h)
        self.fc2 = nn.Linear(4 * h, h)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.fc2(F.relu(self.fc1(self.norm(x))))


class Trunk(nn.Module):
    def __init__(self, in_dim: int, cfg: NetConfig):
        super().__init__()
        self.kind = cfg.kind
        if cfg.kind == 'simba':
            self.inp = nn.Linear(in_dim, cfg.hidden)
            self.blocks = nn.ModuleList(Block(cfg.hidden) for _ in range(cfg.blocks))
            self.out_norm = nn.LayerNorm(cfg.hidden)
            self.out_dim = cfg.hidden
        elif cfg.kind == 'mlp':
            dims = [in_dim, *cfg.mlp_layers]
            self.layers = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims, dims[1:]))
            self.norms = nn.ModuleList(nn.LayerNorm(b) for b in dims[1:])
            self.out_dim = dims[-1]
        else:
            raise ValueError(f'unknown net kind {cfg.kind!r}')

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.kind == 'simba':
            x = self.inp(x)
            for b in self.blocks:
                x = b(x)
            return self.out_norm(x)
        for lin, norm in zip(self.layers, self.norms):
            x = F.relu(norm(lin(x)))
        return x


def squashed_log_prob(u: torch.Tensor, mean: torch.Tensor, log_std: torch.Tensor) -> torch.Tensor:
    """log density of a = tanh(u), u ~ N(mean, std), summed over action dims."""
    z = (u - mean) * torch.exp(-log_std)
    logp = -0.5 * z ** 2 - log_std - 0.5 * math.log(2 * math.pi)
    # log(1 - tanh(u)^2), written stably
    logp = logp - 2.0 * (math.log(2.0) - u - F.softplus(-2.0 * u))
    return logp.sum(-1)


class Actor(nn.Module):
    """Tanh-squashed Gaussian; log-std bounded smoothly to [LOG_STD_MIN, LOG_STD_MAX] by a rescaled tanh."""

    def __init__(self, obs_dim: int, act_dim: int, cfg: NetConfig):
        super().__init__()
        self.act_dim = act_dim
        self.trunk = Trunk(obs_dim, cfg)
        self.head = nn.Linear(self.trunk.out_dim, 2 * act_dim)

    def dist(self, obs_n: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        out = self.head(self.trunk(obs_n)).float()
        mean, raw = out.split(self.act_dim, -1)
        log_std = LOG_STD_MIN + 0.5 * (LOG_STD_MAX - LOG_STD_MIN) * (torch.tanh(raw) + 1.0)
        return mean, log_std

    def sample(self, obs_n: torch.Tensor, eps: torch.Tensor | None = None) -> tuple[torch.Tensor, torch.Tensor]:
        """Reparameterised action and its log-probability; `eps` (standard normal, e.g. coloured noise) or white."""
        mean, log_std = self.dist(obs_n)
        if eps is None:
            eps = torch.randn_like(mean)
        u = mean + torch.exp(log_std) * eps
        return torch.tanh(u), squashed_log_prob(u, mean, log_std)

    def deterministic(self, obs_n: torch.Tensor) -> torch.Tensor:
        return torch.tanh(self.dist(obs_n)[0])


# ---- critic ensemble ------------------------------------------------------------------------------------------------

class BLinear(nn.Module):
    """C independent Linear layers: x [C, B, in] -> [C, B, out]; each initialised like nn.Linear."""

    def __init__(self, c: int, i: int, o: int):
        super().__init__()
        bound = 1.0 / math.sqrt(i)
        self.weight = nn.Parameter(torch.empty(c, i, o).uniform_(-bound, bound))
        self.bias = nn.Parameter(torch.empty(c, 1, o).uniform_(-bound, bound))

    def forward(self, x: torch.Tensor, detach: bool = False) -> torch.Tensor:
        w, b = (self.weight.detach(), self.bias.detach()) if detach else (self.weight, self.bias)
        return torch.baddbmm(b, x, w)


class BLayerNorm(nn.Module):
    def __init__(self, c: int, h: int):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(c, 1, h))
        self.bias = nn.Parameter(torch.zeros(c, 1, h))

    def forward(self, x: torch.Tensor, detach: bool = False) -> torch.Tensor:
        w, b = (self.weight.detach(), self.bias.detach()) if detach else (self.weight, self.bias)
        return F.layer_norm(x, x.shape[-1:]) * w + b


class QuantileEnsemble(nn.Module):
    """`num_critics` critics, each giving `num_quantiles` quantiles of the return of (obs, action): [C, B, Q]."""

    def __init__(self, obs_dim: int, act_dim: int, num_critics: int, num_quantiles: int, cfg: NetConfig):
        super().__init__()
        C, in_dim = num_critics, obs_dim + act_dim
        self.kind = cfg.kind
        self.C = C
        if cfg.kind == 'simba':
            h = cfg.hidden
            self.inp = BLinear(C, in_dim, h)
            self.blocks = nn.ModuleList(nn.ModuleList([BLayerNorm(C, h), BLinear(C, h, 4 * h), BLinear(C, 4 * h, h)])
                                        for _ in range(cfg.blocks))
            self.out_norm = BLayerNorm(C, h)
            out = h
        elif cfg.kind == 'mlp':
            dims = [in_dim, *cfg.mlp_layers]
            self.layers = nn.ModuleList(BLinear(C, a, b) for a, b in zip(dims, dims[1:]))
            self.norms = nn.ModuleList(BLayerNorm(C, b) for b in dims[1:])
            out = dims[-1]
        else:
            raise ValueError(f'unknown net kind {cfg.kind!r}')
        self.head = BLinear(C, out, num_quantiles)

    def forward(self, obs_n: torch.Tensor, act: torch.Tensor, detach: bool = False) -> torch.Tensor:
        x = torch.cat([obs_n, act.to(obs_n.dtype)], -1)
        x = x.unsqueeze(0).expand(self.C, *x.shape)
        if self.kind == 'simba':
            x = self.inp(x, detach)
            for norm, fc1, fc2 in self.blocks:
                x = x + fc2(F.relu(fc1(norm(x, detach), detach)), detach)
            x = self.out_norm(x, detach)
        else:
            for lin, norm in zip(self.layers, self.norms):
                x = F.relu(norm(lin(x, detach), detach))
        return self.head(x, detach).float()
