"""GPU replay buffer: per-environment time-ordered rings, observations stored once, n-step returns at sample time.

Layout: tensors `[E, T, ...]` (E environments, T slots each). Every env step writes, for each env e, one slot at
its head: the observation the action was taken in, the action, the reward and the step's flags (terminated, ended).
The next observation of that transition is the obs of the following slot. When the step ended e's episode, the
env's `final_obs` goes into one extra slot right after it, flagged as a term slot (never sampled as the start of a
transition); the env's next step then writes the new episode's first observation after it. So memory is one
observation per transition (plus one per episode), truncation bootstraps from the true final observation, and a
terminated transition gets discount 0. Heads are absolute slot counts (`head[e]`; the slot is `head % T`); each env
advances by 1 per step, 2 when its episode ended.

A transition at absolute slot t of env e is sampleable when t + n <= head[e] - 1 (its n following slots are
written: if the episode ends within n steps the final observation is among them, written with the ending step) and
t >= head[e] - T (still in the ring). Sampling is uniform over those slots (the env picked by its share of them),
with term slots rejected by redrawing (`REDRAWS` candidates per row; if all were term slots, which needs every
candidate to land on one, the row falls back to the ending transition just before its last candidate: a
negligible bias).

Threads: `add` (the collector) does no GPU work at all: it assigns slots and queues the step in host memory.
`commit` (the learner, before sampling) copies everything queued to the GPU in one host-to-device copy and
scatters it, on the learner's own stream, then updates the heads that sampling reads (`head_gpu`). So sampling,
CUDA-graph replays included, only ever sees fully written slots, by stream order alone. (GPU writes from the
collector's thread would queue behind the learner's GPU work: on this setup a small kernel on a second stream waits
for every kernel queued before it, high priority or not, which tied collection to the learner's speed.)
"""
from __future__ import annotations

import threading

import numpy as np
import torch

REDRAWS = 8
TERMINATED, ENDED, TERM_SLOT = 1, 2, 4  # flag bits


class ReplayBuffer:
    def __init__(self, num_envs: int, obs_dim: int, act_dim: int, capacity: int, device: str | torch.device = 'cuda',
                 obs_dtype: torch.dtype = torch.float32):
        self.E, self.D, self.A = num_envs, obs_dim, act_dim
        self.T = capacity // num_envs
        if self.T < 16:
            raise ValueError(f'capacity {capacity} too small for {num_envs} envs')
        self.device = torch.device(device)
        E, T = self.E, self.T
        self.obs = torch.zeros(E, T, obs_dim, dtype=obs_dtype, device=self.device)
        self.action = torch.zeros(E, T, act_dim, dtype=torch.float32, device=self.device)
        self.reward = torch.zeros(E, T, dtype=torch.float32, device=self.device)
        self.flags = torch.zeros(E, T, dtype=torch.uint8, device=self.device)
        self.head_gpu = torch.zeros(E, dtype=torch.int64, device=self.device)  # committed heads, read by sampling

        self._head = np.zeros(E, dtype=np.int64)       # writer's heads (slots assigned by add)
        self.heads = np.zeros(E, dtype=np.int64)        # committed heads (reader's thread)
        self._pending: list[tuple] = []
        self._lock = threading.Lock()                   # guards _pending
        self._pinned = self.device.type == 'cuda'
        self._stage: list[torch.Tensor | None] = [None, None]  # double-buffered host staging for commit
        self._stage_done: list[torch.cuda.Event | None] = [None, None]
        self._turn = 0
        self.transitions_added = 0                      # committed transitions (all envs)

    # ---- writer (collector thread): host memory only -------------------------------------------------------------

    def add(self, obs: np.ndarray, action: np.ndarray, reward: np.ndarray, terminated: np.ndarray,
            truncated: np.ndarray, done_idx: np.ndarray, final_obs: np.ndarray) -> None:
        """One env step for all E envs: `obs` [E, D] is what each action [E, A] was taken in; `reward`,
        `terminated`, `truncated` [E] are the step's; `done_idx` [K] / `final_obs` [K, D] as `StepResult` has them.
        Queued until the next `commit`."""
        slot = self._head % self.T
        flags = np.asarray(terminated, np.uint8) | (np.logical_or(terminated, truncated).astype(np.uint8) << 1)
        done_idx = np.asarray(done_idx, np.int64)
        final_slot = (self._head[done_idx] + 1) % self.T
        step = (np.array(obs, np.float32), np.array(action, np.float32), np.array(reward, np.float32), flags, slot,
                np.array(final_obs, np.float32).reshape(len(done_idx), self.D), done_idx, final_slot)
        self._head += 1
        self._head[done_idx] += 1
        with self._lock:
            self._pending.append((step, self._head.copy()))

    # ---- reader (learner thread) ---------------------------------------------------------------------------------

    def commit(self) -> int:
        """Writes every queued step to the GPU (on the current stream) and publishes the new heads; returns the
        steps committed. Steps are written in chunks of at most T/2, so no slot is written twice in one scatter."""
        with self._lock:
            pending, self._pending = self._pending, []
        chunk = max(self.T // 2, 1)
        for i in range(0, len(pending), chunk):
            self._write(pending[i:i + chunk])
        return len(pending)

    def _write(self, steps: list[tuple]) -> None:
        E, D, A = self.E, self.D, self.A
        S = len(steps)
        obs = np.concatenate([s[0][0] for s in steps])                        # [S*E, D]
        act = np.concatenate([s[0][1] for s in steps])
        rew = np.concatenate([s[0][2] for s in steps])
        flags = np.concatenate([s[0][3] for s in steps])
        slot = np.concatenate([s[0][4] for s in steps])
        final = np.concatenate([s[0][5] for s in steps])                      # [K, D]
        done = np.concatenate([s[0][6] for s in steps])
        fslot = np.concatenate([s[0][7] for s in steps])
        heads = steps[-1][1]
        K = len(done)
        # one host buffer: f32 [obs | final | act | rew] then i64 [slot | done | fslot | heads], then u8 flags
        f32 = np.concatenate([obs.ravel(), final.ravel(), act.ravel(), rew])
        i64 = np.concatenate([slot, done, fslot, heads])
        off_i = (4 * len(f32) + 7) & ~7
        off_u = off_i + 8 * len(i64)
        nbytes = off_u + len(flags)
        buf = self._staging(nbytes)
        host = buf.numpy()
        host[:4 * len(f32)].view(np.float32)[:] = f32
        host[off_i:off_u].view(np.int64)[:] = i64
        host[off_u:nbytes] = flags
        g = buf[:nbytes].to(self.device, non_blocking=True)
        if self._pinned:
            ev = torch.cuda.Event()
            ev.record()
            self._stage_done[self._turn] = ev
        gf = g[:4 * len(f32)].view(torch.float32)
        gi = g[off_i:off_u].view(torch.int64)
        n_obs, n_fin = S * E * D, K * D
        env = torch.arange(E, device=self.device).repeat(S)
        s = gi[:S * E]
        self.obs[env, s] = gf[:n_obs].view(S * E, D).to(self.obs.dtype)
        self.action[env, s] = gf[n_obs + n_fin:n_obs + n_fin + S * E * A].view(S * E, A)
        self.reward[env, s] = gf[n_obs + n_fin + S * E * A:]
        self.flags[env, s] = g[off_u:nbytes]
        if K:  # term slots: the final observations (their action and reward stay stale and are never used)
            d, fs = gi[S * E:S * E + K], gi[S * E + K:S * E + 2 * K]
            self.obs[d, fs] = gf[n_obs:n_obs + n_fin].view(K, D).to(self.obs.dtype)
            self.flags[d, fs] = TERM_SLOT
        self.head_gpu.copy_(gi[S * E + 2 * K:])
        self.heads = heads.copy()
        self.transitions_added += S * E

    def _staging(self, nbytes: int) -> torch.Tensor:
        """A host buffer of at least nbytes whose previous copy to the GPU has finished (two, used in turn)."""
        self._turn ^= 1
        t = self._turn
        if self._stage_done[t] is not None:
            self._stage_done[t].synchronize()
        if self._stage[t] is None or self._stage[t].numel() < nbytes:
            self._stage[t] = torch.empty(max(nbytes, 1 << 16) * 2, dtype=torch.uint8, pin_memory=self._pinned)
        return self._stage[t]

    def size(self) -> int:
        """Committed slots in use (transitions plus one term slot per ended episode)."""
        return int(np.minimum(self.heads, self.T).sum())

    def can_sample(self, n_step: int) -> bool:
        hi = self.heads - n_step
        lo = np.maximum(self.heads - self.T, 0)
        return bool((hi - lo > 0).any())

    def sample_index(self, batch_size: int, n_step: int) -> tuple[torch.Tensor, torch.Tensor]:
        """Uniform (env, absolute slot) pairs of sampleable transitions; needs at least one (`can_sample`).
        Pure GPU work on `head_gpu`: no host sync, fixed shapes (CUDA-graph safe)."""
        head = self.head_gpu
        hi = head - n_step                                         # exclusive
        lo = torch.clamp(head - self.T, min=0)
        count = torch.clamp(hi - lo, min=0)
        cum = torch.cumsum(count, 0)
        total = cum[-1]
        u = torch.rand(batch_size, REDRAWS, device=self.device, dtype=torch.float64) * total
        u = torch.minimum(u.long(), total - 1)
        env = torch.searchsorted(cum, u, right=True)
        t = lo[env] + u - (cum[env] - count[env])
        bad = (self.flags[env, t % self.T] & TERM_SLOT) > 0        # [B, R]
        first = torch.argmax((~bad).to(torch.int8), dim=1)         # first good candidate (0 if none)
        rows = torch.arange(batch_size, device=self.device)
        env, t = env[rows, first], t[rows, first]
        t = t - bad[rows, first].long()                            # all bad: the ending transition before it
        return env, t

    def gather(self, env: torch.Tensor, t: torch.Tensor, n_step: int, gamma: float):
        """n-step tuples for transitions (env, t): obs, action, discounted reward sum, next_obs, discount."""
        T = self.T
        k = torch.arange(n_step, device=self.device)
        tk = (t[:, None] + k) % T                                  # [B, n]
        e = env[:, None]
        r = self.reward[e, tk]
        f = self.flags[e, tk]
        ended = ((f & ENDED) > 0).int()
        term = (f & TERMINATED) > 0
        before = torch.cumsum(ended, 1) - ended                    # ends strictly before step k
        alive = before == 0                                        # step k is part of the n-step window
        powers = gamma ** k.to(torch.float32)
        ret = torch.where(alive, powers * r, 0.0).sum(1)
        steps = alive.sum(1)                                       # first end + 1, or n
        terminated = (alive & term).any(1)
        discount = torch.where(terminated, 0.0, gamma ** steps.to(torch.float32))
        nxt = (t + steps) % T
        s = t % T
        return self.obs[env, s].float(), self.action[env, s], ret, self.obs[env, nxt].float(), discount

    def sample(self, batch_size: int, n_step: int, gamma: float):
        self.commit()
        env, t = self.sample_index(batch_size, n_step)
        return self.gather(env, t, n_step, gamma)

    def memory_bytes(self) -> int:
        return sum(x.numel() * x.element_size() for x in (self.obs, self.action, self.reward, self.flags))
