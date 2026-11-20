"""Every hyperparameter of a training run, as one dataclass tree.

Load order: defaults, then a JSON file (`--config`), then `--set key.sub=value` pairs (the value is parsed as JSON
when it parses, else taken as a string: `--set sac.gamma=0.99`, `--set env.reset.cars='["lcf1","lcgt3"]'`,
`--set collect.noise=pink`). The effective config is saved as `config.json` in the run folder.
"""
from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class NetConfig:
    kind: str = 'simba'          # 'simba' (residual blocks) or 'mlp' (Linear -> LayerNorm -> ReLU per layer)
    hidden: int = 512            # simba: trunk width
    blocks: int = 2              # simba: residual blocks (LN -> Linear(h, 4h) -> ReLU -> Linear(4h, h), added)
    mlp_layers: list[int] = field(default_factory=lambda: [512, 512, 512])  # mlp: layer widths


@dataclass
class SACConfig:
    gamma: float = 0.992
    n_step: int = 3
    batch_size: int = 512
    reward_scale: float = 0.1     # applied in the learner (the env's reward is metres of progress)
    tau: float = 0.005            # Polyak rate of the target critics
    lr_actor: float = 3e-4
    lr_critic: float = 3e-4
    lr_alpha: float = 3e-4
    weight_decay: float = 0.0     # > 0: AdamW with this decay (actor and critics, never log-alpha)
    grad_clip: float = 0.0        # max global grad norm per network (0: off; norms are logged either way)
    num_critics: int = 2
    num_quantiles: int = 32
    top_drop_per_net: int = 2     # TQC: target quantiles dropped per critic from the top of the pooled set
    init_alpha: float = 0.1
    target_entropy: float = -2.0  # -|A|
    target_entropy_final: float | None = None  # set (with target_entropy_steps) for a linear schedule over env steps
    target_entropy_steps: int = 0
    actor_q: str = 'mean'         # actor objective: 'mean' over critics and quantiles, or 'min' of per-critic means
    policy_delay: int = 1         # actor and alpha step every this many critic steps
    actor: NetConfig = field(default_factory=lambda: NetConfig(hidden=256, blocks=1, mlp_layers=[256, 256]))
    critic: NetConfig = field(default_factory=NetConfig)
    obs_norm: bool = True
    obs_norm_std_floor: float = 0.05  # see networks.ObsNorm
    # speed (no effect on the maths beyond float rounding)
    compile: bool = True          # torch.compile the loss functions (inductor fusion: ~1.35x; ~20 s warm-up cold)
    cuda_graph: bool = True       # capture each update as a CUDA graph (CUDA only)
    amp: str = 'bf16'             # 'bf16' autocast for the networks' matmuls, or 'off' (float32; TF32 per `tf32`)
    tf32: bool = True
    updates_per_call: int = 50    # updates per Python call of the learner (metrics are read only when logging)


@dataclass
class ReplayConfig:
    capacity: int = 3_000_000     # transitions, all environments together
    obs_dtype: str = 'float32'    # or 'float16'


@dataclass
class CollectConfig:
    num_workers: int = 5
    envs_per_worker: int = 8
    random_steps: int = 10_000    # env steps (all envs together) of uniform random actions at the start
    learning_starts: int = 10_000  # transitions in the buffer before the first update (also the refill on resume)
    utd: float = 1.0              # cap: updates never exceed utd x env steps collected
    min_utd: float = 0.0          # > 0: collection pauses while updates < min_utd x env steps
    noise: str = 'white'          # exploration noise of the sampled policy: 'white' or 'pink'
    pink_chunk: int = 2000        # pink noise: sequence length per FFT draw (steps; ~ an episode)
    actor_sync_secs: float = 1.0


@dataclass
class EvalConfig:
    every_secs: float = 300.0
    combos: list[list[str]] = field(default_factory=lambda: [['melbourne', 'lcf1']])
    num_workers: int = 1
    invalid_lap_secs: float = 1000.0  # score of a combo whose lap is invalid or unfinished


@dataclass
class TrainConfig:
    env: dict[str, Any] = field(default_factory=dict)  # passed verbatim as the env worker's config
    # None: train on the env's own reward. A dict (may be empty): the trainer's speed-scaled reward (reward.py), with
    # these coefficients over its defaults; the env's own wall and off-track penalties are then turned off
    reward: dict[str, float] | None = None
    sac: SACConfig = field(default_factory=SACConfig)
    replay: ReplayConfig = field(default_factory=ReplayConfig)
    collect: CollectConfig = field(default_factory=CollectConfig)
    eval: EvalConfig = field(default_factory=EvalConfig)
    seed: int = 0
    device: str = 'cuda'
    log_every_secs: float = 15.0
    checkpoint_every_secs: float = 1800.0
    max_env_steps: int = 0        # stop after this many env steps (0: run until interrupted)


def to_dict(cfg: Any) -> dict:
    return dataclasses.asdict(cfg)


def from_dict(cls: type, data: dict) -> Any:
    """Builds `cls` from a (partial) dict, recursing into nested dataclasses; unknown keys are an error."""
    hints = {f.name: f for f in dataclasses.fields(cls)}
    kwargs = {}
    for key, value in data.items():
        if key not in hints:
            raise KeyError(f'unknown config key {cls.__name__}.{key}')
        default = getattr(cls(), key)
        kwargs[key] = from_dict(type(default), value) if dataclasses.is_dataclass(default) else value
    return cls(**kwargs)


def merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def parse_set(pairs: list[str]) -> dict:
    """['a.b=1', 'env.reset.tracks=["x"]'] -> {'a': {'b': 1}, 'env': {'reset': {'tracks': ['x']}}}"""
    out: dict = {}
    for pair in pairs:
        key, sep, raw = pair.partition('=')
        if not sep:
            raise ValueError(f'--set needs key=value, got {pair!r}')
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = raw
        node = out
        *path, last = key.strip().split('.')
        for p in path:
            node = node.setdefault(p, {})
        node[last] = value
    return out


def load_config(path: str | Path | None = None, sets: list[str] | None = None, base: dict | None = None) -> TrainConfig:
    data = to_dict(TrainConfig()) if base is None else base
    if path:
        data = merge(data, json.loads(Path(path).read_text()))
    if sets:
        data = merge(data, parse_set(sets))
    return from_dict(TrainConfig, data)


def save_config(cfg: TrainConfig, path: str | Path) -> None:
    Path(path).write_text(json.dumps(to_dict(cfg), indent=2) + '\n')
