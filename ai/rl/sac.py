"""Distributional SAC (TQC-style quantile critics, Kuznetsov et al. 2020; the family of GT Sophy's QR-SAC).

One update: sample n-step tuples from the GPU replay buffer; target = r_n + discount x (the pooled target critics'
quantiles, sorted, top `top_drop_per_net` x C dropped, minus alpha x log pi(a'|s')) with a' ~ pi(s'); quantile-Huber
loss of every critic's quantiles against every target atom; then the actor (alpha log pi - Q, Q the mean over
quantiles then over critics, or the min of per-critic means), the temperature (log-alpha towards the target
entropy) and the Polyak target update. On CUDA each update is captured once as a CUDA graph (sampling included) and
replayed: Python launches one graph per update instead of hundreds of kernels.
"""
from __future__ import annotations

import contextlib
import copy
import json
import math
import os
from pathlib import Path

import numpy as np
import torch

from config import SACConfig, load_config
from networks import OBS_CLIP, Actor, QuantileEnsemble, normalize, squashed_log_prob
from policy_np import FORMAT, NumpyPolicy
from replay import ReplayBuffer

CRITIC_METRICS = ('critic_loss', 'q_mean', 'target_q_mean', 'critic_grad_norm')
os.environ.setdefault('TRITON_DEFAULT_FP_FUSION', '1')  # Triton 3.9's default (torch.compile), minus its warning
WARMUP = 3  # eager updates before a CUDA graph capture
ACTOR_METRICS = ('actor_loss', 'alpha_loss', 'entropy', 'alpha', 'actor_grad_norm', 'action_rate')


def quantile_huber_loss(pred: torch.Tensor, target: torch.Tensor, kappa: float = 1.0) -> torch.Tensor:
    """pred [C, B, Q] quantiles at fractions tau_i = (2i + 1) / 2Q, target [B, M] atoms. Mean over critics, batch,
    quantiles and atoms of |tau_i - 1{u < 0}| x huber_kappa(u) / kappa, u = target_j - pred_i (TQC's form)."""
    Q = pred.shape[-1]
    tau = (torch.arange(Q, device=pred.device, dtype=pred.dtype) + 0.5) / Q
    u = target[None, :, None, :] - pred[..., None]                   # [C, B, Q, M]
    abs_u = u.abs()
    huber = torch.where(abs_u <= kappa, 0.5 * u ** 2, kappa * (abs_u - 0.5 * kappa)) / kappa
    return ((tau[:, None] - (u < 0).to(pred.dtype)).abs() * huber).mean()


def tqc_target(next_q: torch.Tensor, drop_per_net: int, reward: torch.Tensor, discount: torch.Tensor,
               alpha: torch.Tensor, next_logp: torch.Tensor) -> torch.Tensor:
    """next_q [C, B, Q] -> target atoms [B, C x (Q - drop)]: pooled, sorted, the top C x drop removed."""
    C, B, Q = next_q.shape
    pooled = next_q.permute(1, 0, 2).reshape(B, C * Q).sort(dim=1).values
    kept = pooled[:, :C * (Q - drop_per_net)]
    return reward[:, None] + discount[:, None] * (kept - alpha * next_logp[:, None])


def _grad_norm(params: list[torch.Tensor], max_norm: float) -> torch.Tensor:
    grads = [p.grad for p in params]
    norm = torch.linalg.vector_norm(torch.stack(torch._foreach_norm(grads)))
    if max_norm > 0:
        torch._foreach_mul_(grads, torch.clamp(max_norm / (norm + 1e-6), max=1.0))
    return norm


class SAC:
    def __init__(self, cfg: SACConfig, obs_dim: int, act_dim: int, device: str | torch.device = 'cuda'):
        self.cfg, self.obs_dim, self.act_dim = cfg, obs_dim, act_dim
        self.device = dev = torch.device(device)
        cuda = dev.type == 'cuda'
        if cuda:
            torch.backends.cuda.matmul.allow_tf32 = cfg.tf32
            torch.backends.cudnn.allow_tf32 = cfg.tf32
        if cfg.top_drop_per_net >= cfg.num_quantiles:
            raise ValueError('top_drop_per_net must be below num_quantiles')
        self.actor = Actor(obs_dim, act_dim, cfg.actor, cfg.action_scale).to(dev)
        self.critic = QuantileEnsemble(obs_dim, act_dim, cfg.num_critics, cfg.num_quantiles, cfg.critic).to(dev)
        self.target = copy.deepcopy(self.critic).requires_grad_(False)
        self.log_alpha = torch.tensor(math.log(cfg.init_alpha), device=dev, requires_grad=True)
        self._rate_w = self._prev_idx = None
        if any(cfg.rate_reg):
            if len(cfg.rate_reg) != act_dim or len(cfg.prev_action_index) != act_dim:
                raise ValueError('rate_reg and prev_action_index need one entry per action')
            self._rate_w = torch.tensor(cfg.rate_reg, device=dev)
            self._prev_idx = torch.tensor(cfg.prev_action_index, device=dev)
        self.use_graph = cfg.cuda_graph and cuda
        opt_kw = dict(fused=True, capturable=self.use_graph) if cuda else {}
        Opt = torch.optim.AdamW if cfg.weight_decay > 0 else torch.optim.Adam
        wd = dict(weight_decay=cfg.weight_decay) if cfg.weight_decay > 0 else {}
        self.actor_opt = Opt(self.actor.parameters(), lr=cfg.lr_actor, **wd, **opt_kw)
        self.critic_opt = Opt(self.critic.parameters(), lr=cfg.lr_critic, **wd, **opt_kw)
        self.alpha_opt = torch.optim.Adam([self.log_alpha], lr=cfg.lr_alpha, **opt_kw)
        self._critic_params = list(self.critic.parameters())
        self._target_params = list(self.target.parameters())
        self._actor_params = list(self.actor.parameters())
        # frozen normaliser stats (set_obs_stats), target entropy (set per update call)
        self.obs_mean = torch.zeros(obs_dim, device=dev)
        self.obs_inv_std = torch.ones(obs_dim, device=dev)
        self.target_entropy = torch.tensor(float(cfg.target_entropy), device=dev)
        # metrics summed on the device, read by read_metrics
        self._critic_sum = torch.zeros(len(CRITIC_METRICS), device=dev)
        self._actor_sum = torch.zeros(len(ACTOR_METRICS), device=dev)
        self._critic_n = self._actor_n = 0
        self.updates = 0
        self.replay: ReplayBuffer | None = None
        self._graphs: dict[bool, torch.cuda.CUDAGraph] = {}
        self._last_call: torch.cuda.Event | None = None
        if cfg.compile:
            import torch._inductor.config as inductor
            inductor.compile_threads = 1  # in-process: its default pool is 12 processes of ~400 MB each (8 GB RAM)
        self._critic_loss = torch.compile(self.critic_loss) if cfg.compile else self.critic_loss
        self._actor_loss = torch.compile(self.actor_loss) if cfg.compile else self.actor_loss

    # ---- losses -------------------------------------------------------------------------------------------------

    def _amp(self):
        if self.cfg.amp == 'bf16' and self.device.type == 'cuda':
            return torch.autocast('cuda', dtype=torch.bfloat16, cache_enabled=False)
        return contextlib.nullcontext()

    def norm(self, obs: torch.Tensor) -> torch.Tensor:
        return normalize(obs, self.obs_mean, self.obs_inv_std)

    def critic_loss(self, obs, act, ret, nobs, disc):
        cfg = self.cfg
        alpha = self.log_alpha.detach().exp()
        with torch.no_grad():
            no = self.norm(nobs)
            with self._amp():
                na, nlogp = self.actor.sample(no)
                tq = self.target(no, na)
            target = tqc_target(tq, cfg.top_drop_per_net, ret * cfg.reward_scale, disc, alpha, nlogp)
        with self._amp():
            q = self.critic(self.norm(obs), act)
        loss = quantile_huber_loss(q, target)
        return loss, q.detach().mean(), target.mean()

    def actor_loss(self, obs):
        o = self.norm(obs)
        with self._amp():
            mean, log_std = self.actor.dist(o)
            u = mean + torch.exp(log_std) * torch.randn_like(mean)
            a, logp = self.actor.squash(u), squashed_log_prob(u, mean, log_std)
            qa = self.critic(o, a, detach=True).mean(-1)               # [C, B]
        q = qa.mean(0) if self.cfg.actor_q == 'mean' else qa.min(0).values
        alpha = self.log_alpha.detach().exp()
        actor_loss = (alpha * logp - q).mean()
        if self._rate_w is not None:   # how far the mean action is from the previous one, per action [A]
            rate = (self.actor.squash(mean) - obs[:, self._prev_idx].float()).abs().mean(0)
            actor_loss = actor_loss + (rate * self._rate_w).sum()
            rate = rate.detach().mean()
        else:
            rate = torch.zeros((), device=obs.device)
        alpha_loss = -(self.log_alpha * (logp.detach() + self.target_entropy)).mean()
        return actor_loss, alpha_loss, -logp.detach().mean(), alpha, rate

    # ---- one update ---------------------------------------------------------------------------------------------

    def _sample(self):
        cfg, rb = self.cfg, self.replay
        env, t = rb.sample_index(cfg.batch_size, cfg.n_step)
        return rb.gather(env, t, cfg.n_step, cfg.gamma)

    def _step(self, with_actor: bool) -> None:
        cfg = self.cfg
        obs, act, ret, nobs, disc = self._sample()
        loss, q_mean, t_mean = self._critic_loss(obs, act, ret, nobs, disc)
        self.critic_opt.zero_grad(set_to_none=True)
        loss.backward()
        gn = _grad_norm(self._critic_params, cfg.grad_clip)
        self.critic_opt.step()
        self._critic_sum += torch.stack([loss.detach(), q_mean, t_mean, gn])
        if with_actor:
            a_loss, al_loss, ent, alpha, rate = self._actor_loss(obs)
            self.actor_opt.zero_grad(set_to_none=True)
            self.alpha_opt.zero_grad(set_to_none=True)
            (a_loss + al_loss).backward()  # alpha is detached in a_loss, so log-alpha's grad is al_loss's alone
            agn = _grad_norm(self._actor_params, cfg.grad_clip)
            self.actor_opt.step()
            self.alpha_opt.step()
            self._actor_sum += torch.stack([a_loss.detach(), al_loss.detach(), ent, alpha, agn, rate])
        torch._foreach_lerp_(self._target_params, self._critic_params, cfg.tau)

    def _capture(self) -> int:
        """Warm up (also compiles) on a side stream, then capture there the update with and without the actor
        step. Returns the warm-up updates done."""
        kinds = [True] if self.cfg.policy_delay == 1 else [True, False]
        side = torch.cuda.Stream(self.device)
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for _ in range(WARMUP):
                for kind in kinds:
                    self._step(kind)
                    self._count(kind)
        pool = None
        for kind in kinds:
            g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g, pool=pool, stream=side, capture_error_mode='thread_local'):
                self._step(kind)
            pool = g.pool()
            self._graphs[kind] = g
        torch.cuda.current_stream().wait_stream(side)
        return WARMUP * len(kinds)

    def _count(self, with_actor: bool) -> None:
        self.updates += 1
        self._critic_n += 1
        self._actor_n += with_actor

    def update(self, k: int, env_steps: int = 0) -> None:
        """k updates (the first call's include the warm-up before graph capture). Waits for the previous call's updates to finish first, so the GPU never runs more than one
        call behind (so `updates` stays near the truth and the queue never grows)."""
        cfg = self.cfg
        if self._last_call is not None:
            self._last_call.synchronize()
        self.target_entropy.fill_(self.target_entropy_at(env_steps))
        self.replay.commit()
        if self.use_graph and not self._graphs:
            k = max(k - self._capture(), 0)
        for _ in range(k):
            with_actor = self.updates % cfg.policy_delay == 0
            if self.use_graph:
                self._graphs[with_actor].replay()
            else:
                self._step(with_actor)
            self._count(with_actor)
        if self.device.type == 'cuda':
            self._last_call = torch.cuda.Event(blocking=True)  # wait without spinning a core
            self._last_call.record()

    def target_entropy_at(self, env_steps: int) -> float:
        cfg = self.cfg
        if cfg.target_entropy_final is None or cfg.target_entropy_steps <= 0:
            return cfg.target_entropy
        f = min(env_steps / cfg.target_entropy_steps, 1.0)
        return cfg.target_entropy + f * (cfg.target_entropy_final - cfg.target_entropy)

    def read_metrics(self) -> dict[str, float]:
        """Means since the last read (one host sync)."""
        out: dict[str, float] = {}
        if self._critic_n:
            out.update(zip(CRITIC_METRICS, (self._critic_sum / self._critic_n).tolist()))
        if self._actor_n:
            out.update(zip(ACTOR_METRICS, (self._actor_sum / self._actor_n).tolist()))
        self._critic_sum.zero_()
        self._actor_sum.zero_()
        self._critic_n = self._actor_n = 0
        return out

    # ---- acting, normaliser, state ------------------------------------------------------------------------------

    def set_obs_stats(self, mean: np.ndarray, std: np.ndarray) -> None:
        self.obs_mean.copy_(torch.as_tensor(mean, dtype=torch.float32))
        self.obs_inv_std.copy_(torch.as_tensor(1.0 / std, dtype=torch.float32))

    @torch.no_grad()
    def act(self, obs: np.ndarray, deterministic: bool = True) -> np.ndarray:
        o = self.norm(torch.as_tensor(obs, dtype=torch.float32, device=self.device))
        a = self.actor.deterministic(o) if deterministic else self.actor.sample(o)[0]
        return a.cpu().numpy()

    def policy_state(self) -> dict:
        """Actor weights and normaliser stats on the CPU, for the collector's and the evaluator's copies."""
        return {'actor': {k: v.detach().cpu().clone() for k, v in self.actor.state_dict().items()},
                'obs_mean': self.obs_mean.cpu().clone(), 'obs_inv_std': self.obs_inv_std.cpu().clone()}

    def state_dict(self) -> dict:
        return {
            'actor': self.actor.state_dict(), 'critic': self.critic.state_dict(), 'target': self.target.state_dict(),
            'actor_opt': self.actor_opt.state_dict(), 'critic_opt': self.critic_opt.state_dict(),
            'alpha_opt': self.alpha_opt.state_dict(), 'log_alpha': self.log_alpha.detach().clone(),
            'obs_mean': self.obs_mean.clone(), 'obs_inv_std': self.obs_inv_std.clone(), 'updates': self.updates,
        }

    def load_state_dict(self, d: dict) -> None:
        """Copies in place, so captured CUDA graphs stay valid."""
        self.actor.load_state_dict(d['actor'])
        self.critic.load_state_dict(d['critic'])
        self.target.load_state_dict(d['target'])
        self.actor_opt.load_state_dict(d['actor_opt'])
        self.critic_opt.load_state_dict(d['critic_opt'])
        self.alpha_opt.load_state_dict(d['alpha_opt'])
        with torch.no_grad():
            self.log_alpha.copy_(d['log_alpha'])
        self.obs_mean.copy_(d['obs_mean'])
        self.obs_inv_std.copy_(d['obs_inv_std'])
        self.updates = d['updates']

    def export_policy(self, path: str | Path) -> None:
        """The deterministic actor as a `.npz` (layout in policy_np.py)."""
        arrays, ops = actor_arrays(self.actor)
        meta = {'format': FORMAT, 'version': 1, 'obs_dim': self.obs_dim, 'act_dim': self.act_dim,
                'obs_clip': OBS_CLIP, 'ops': ops, 'act_scale': self.actor.act_scale.tolist(),
                'output': f'first {self.act_dim} outputs: Gaussian mean; action = clamp(act_scale x tanh(mean), -1, 1)'}
        arrays['obs_mean'] = self.obs_mean.cpu().numpy().astype(np.float32)
        arrays['obs_scale'] = self.obs_inv_std.cpu().numpy().astype(np.float32)
        np.savez(path, meta=np.array(json.dumps(meta)), **arrays)


def actor_arrays(actor: Actor) -> tuple[dict[str, np.ndarray], list[dict]]:
    arrays: dict[str, np.ndarray] = {}
    ops: list[dict] = []

    def lin(m: torch.nn.Linear) -> None:
        i = len(arrays) // 2
        arrays[f'w{i}'] = m.weight.detach().float().cpu().numpy().T.copy()
        arrays[f'b{i}'] = m.bias.detach().float().cpu().numpy()
        ops.append({'op': 'linear', 'w': f'w{i}', 'b': f'b{i}'})

    def ln(m: torch.nn.LayerNorm) -> None:
        i = len(arrays) // 2
        arrays[f'ln{i}_w'] = m.weight.detach().float().cpu().numpy()
        arrays[f'ln{i}_b'] = m.bias.detach().float().cpu().numpy()
        ops.append({'op': 'layernorm', 'w': f'ln{i}_w', 'b': f'ln{i}_b', 'eps': m.eps})

    tr = actor.trunk
    if tr.kind == 'simba':
        lin(tr.inp)
        for b in tr.blocks:
            ops.append({'op': 'push'})
            ln(b.norm)
            lin(b.fc1)
            ops.append({'op': 'relu'})
            lin(b.fc2)
            ops.append({'op': 'add'})
        ln(tr.out_norm)
    else:
        for l, n in zip(tr.layers, tr.norms):
            lin(l)
            ln(n)
            ops.append({'op': 'relu'})
    lin(actor.head)
    return arrays, ops


def load_act_fn(path: str | Path):
    """A deterministic act_fn(obs [n, D] f32) -> [n, A] f32 from a training checkpoint (.pt: latest.pt, best.pt,
    ckpt-*.pt) or an exported policy (.npz)."""
    if str(path).endswith('.npz'):
        return NumpyPolicy(path)
    ck = torch.load(path, map_location='cpu', weights_only=False)
    policy = CpuPolicy(load_config(base=ck['config']).sac, ck['obs_dim'], ck['act_dim'])
    policy.load(ck['policy'])
    return lambda obs: policy(obs, deterministic=True)


class CpuPolicy:
    """A CPU copy of the actor and the normaliser (collector and evaluator threads), refreshed with `load`."""

    def __init__(self, cfg: SACConfig, obs_dim: int, act_dim: int):
        self.actor = Actor(obs_dim, act_dim, cfg.actor, cfg.action_scale)
        self.actor.requires_grad_(False)
        self.mean = torch.zeros(obs_dim)
        self.inv_std = torch.ones(obs_dim)

    def load(self, state: dict) -> None:
        self.actor.load_state_dict(state['actor'])
        self.mean.copy_(state['obs_mean'])
        self.inv_std.copy_(state['obs_inv_std'])

    @torch.no_grad()
    def __call__(self, obs: np.ndarray, eps: np.ndarray | None = None, deterministic: bool = False) -> np.ndarray:
        o = normalize(torch.from_numpy(np.asarray(obs, dtype=np.float32)), self.mean, self.inv_std)
        if deterministic:
            return self.actor.deterministic(o).numpy()
        e = None if eps is None else torch.from_numpy(np.asarray(eps, dtype=np.float32))
        return self.actor.sample(o, e)[0].numpy()
