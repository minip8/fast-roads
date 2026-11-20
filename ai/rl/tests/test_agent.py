"""The SAC agent: shapes, the loss and target maths on hand-computed cases, the batched ensemble against a loop,
checkpoints, the numpy export, acting, and the CUDA-graph update path."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import NetConfig, SACConfig  # noqa: E402
from networks import LOG_STD_MAX, LOG_STD_MIN, RunningStats, squashed_log_prob  # noqa: E402
from policy_np import NumpyPolicy  # noqa: E402
from replay import ReplayBuffer  # noqa: E402
from sac import SAC, CpuPolicy, quantile_huber_loss, tqc_target  # noqa: E402

D, A = 11, 2


def small_cfg(**kw) -> SACConfig:
    cfg = SACConfig(actor=NetConfig(hidden=32, blocks=1, mlp_layers=[32, 32]),
                    critic=NetConfig(hidden=48, blocks=2, mlp_layers=[48, 48]),
                    num_quantiles=8, top_drop_per_net=1, batch_size=64, cuda_graph=False, amp='off',
                    compile=False)
    for k, v in kw.items():
        setattr(cfg, k, v)
    return cfg


def filled_buffer(device: str, steps: int = 200, E: int = 4) -> ReplayBuffer:
    rng = np.random.default_rng(0)
    rb = ReplayBuffer(E, D, A, E * 400, device=device)
    for _ in range(steps):
        end = rng.random(E) < 0.05
        term = end & (rng.random(E) < 0.5)
        d = np.flatnonzero(end)
        rb.add(rng.standard_normal((E, D)).astype(np.float32), rng.uniform(-1, 1, (E, A)).astype(np.float32),
               rng.standard_normal(E).astype(np.float32), term, end & ~term, d,
               rng.standard_normal((len(d), D)).astype(np.float32))
    rb.commit()
    return rb


def agent(device='cpu', **kw) -> SAC:
    torch.manual_seed(0)
    a = SAC(small_cfg(**kw), D, A, device)
    a.replay = filled_buffer(device)
    return a


@pytest.mark.parametrize('kind', ['simba', 'mlp'])
def test_shapes(kind):
    a = agent(actor=NetConfig(kind=kind, hidden=32, blocks=1, mlp_layers=[32, 32]),
              critic=NetConfig(kind=kind, hidden=48, blocks=2, mlp_layers=[48, 48]))
    obs = torch.randn(5, D)
    act, logp = a.actor.sample(obs)
    assert act.shape == (5, A) and logp.shape == (5,) and act.abs().max() < 1
    mean, log_std = a.actor.dist(obs)
    assert mean.shape == log_std.shape == (5, A)
    assert LOG_STD_MIN <= log_std.min() and log_std.max() <= LOG_STD_MAX
    q = a.critic(obs, act)
    assert q.shape == (2, 5, 8)
    t = tqc_target(q, 1, torch.zeros(5), torch.ones(5), torch.tensor(0.1), logp)
    assert t.shape == (5, 2 * 7)


def test_log_prob_matches_torch_distributions():
    mean, log_std = torch.randn(6, A), torch.randn(6, A) * 0.5
    u = mean + log_std.exp() * torch.randn(6, A)
    base = torch.distributions.Normal(mean, log_std.exp())
    ref = (base.log_prob(u) - torch.log(1 - torch.tanh(u) ** 2)).sum(-1)
    torch.testing.assert_close(squashed_log_prob(u, mean, log_std), ref, rtol=1e-4, atol=1e-4)


def test_quantile_huber_hand_computed():
    # one critic, one sample, quantiles at tau = 0.25, 0.75 with values 0 and 1; target atoms 0.5 and 3.
    pred = torch.tensor([[[0.0, 1.0]]])
    target = torch.tensor([[0.5, 3.0]])
    # u = target - pred:  (q0: 0.5, 3.0), (q1: -0.5, 2.0)
    # huber (kappa 1):     0.125, 2.5       0.125, 1.5
    # weight |tau - 1{u<0}|: q0: 0.25, 0.25  q1: |0.75 - 1| = 0.25, 0.75
    expected = (0.25 * 0.125 + 0.25 * 2.5 + 0.25 * 0.125 + 0.75 * 1.5) / 4
    assert quantile_huber_loss(pred, target).item() == pytest.approx(expected)
    # two critics: the mean over critics
    pred2 = torch.cat([pred, pred + 10], 0)
    # values 10, 11: u = (-9.5, -7), (-10.5, -8), huber |u| - 0.5, all u < 0 so the weights are 1 - tau
    second = (0.75 * 9.0 + 0.75 * 6.5 + 0.25 * 10.0 + 0.25 * 7.5) / 4
    assert quantile_huber_loss(pred2, target).item() == pytest.approx((expected + second) / 2)


def test_tqc_target_drop_and_no_drop():
    next_q = torch.tensor([[[1.0, 5.0, 3.0]], [[4.0, 2.0, 6.0]]])  # C=2, B=1, Q=3
    reward, disc, alpha, logp = torch.tensor([1.0]), torch.tensor([0.5]), torch.tensor(0.2), torch.tensor([-1.0])
    # pooled sorted: 1 2 3 4 5 6; drop 1 per net -> top 2 gone; entropy: -alpha * logp = +0.2
    t = tqc_target(next_q, 1, reward, disc, alpha, logp)
    torch.testing.assert_close(t, 1.0 + 0.5 * (torch.tensor([[1.0, 2, 3, 4]]) + 0.2))
    t0 = tqc_target(next_q, 0, reward, disc, alpha, logp)
    torch.testing.assert_close(t0, 1.0 + 0.5 * (torch.tensor([[1.0, 2, 3, 4, 5, 6]]) + 0.2))
    t_term = tqc_target(next_q, 0, reward, torch.tensor([0.0]), alpha, logp)
    torch.testing.assert_close(t_term, torch.ones(1, 6))


@pytest.mark.parametrize('kind', ['simba', 'mlp'])
def test_batched_ensemble_equals_per_critic_loop(kind):
    a = agent(critic=NetConfig(kind=kind, hidden=48, blocks=2, mlp_layers=[48, 40]))
    obs, act = torch.randn(7, D), torch.rand(7, A) * 2 - 1
    q = a.critic(obs, act)
    cr = a.critic
    for c in range(2):
        def lin(m, x):
            return x @ m.weight[c] + m.bias[c, 0]

        def ln(m, x):
            return F.layer_norm(x, x.shape[-1:]) * m.weight[c, 0] + m.bias[c, 0]
        x = torch.cat([obs, act], -1)
        if kind == 'simba':
            x = lin(cr.inp, x)
            for norm, fc1, fc2 in cr.blocks:
                x = x + lin(fc2, F.relu(lin(fc1, ln(norm, x))))
            x = ln(cr.out_norm, x)
        else:
            for l, n in zip(cr.layers, cr.norms):
                x = F.relu(ln(n, lin(l, x)))
        torch.testing.assert_close(q[c], lin(cr.head, x), rtol=1e-5, atol=1e-5)


def test_updates_move_networks_and_detach_critic_in_actor_loss():
    a = agent()
    before = [p.detach().clone() for p in a.critic.parameters()]
    a.update(5)
    m = a.read_metrics()
    assert set(m) >= {'critic_loss', 'actor_loss', 'alpha', 'entropy', 'q_mean', 'critic_grad_norm'}
    assert all(np.isfinite(v) for v in m.values())
    assert any(not torch.equal(b, p) for b, p in zip(before, a.critic.parameters()))
    # the actor loss must not write critic gradients
    a.critic.zero_grad(set_to_none=True)
    loss, *_ = a.actor_loss(torch.randn(8, D))
    loss.backward()
    assert all(p.grad is None for p in a.critic.parameters())


def test_policy_delay_and_min_q():
    a = agent(policy_delay=2, actor_q='min')
    a.update(6)
    assert a._critic_n == 6 and a._actor_n == 3
    a.read_metrics()


def test_checkpoint_round_trip(tmp_path):
    a = agent()
    a.update(4)
    a.set_obs_stats(np.linspace(-1, 1, D), np.linspace(0.5, 2, D))
    torch.save(a.state_dict(), tmp_path / 'ck.pt')
    b = agent()
    b.load_state_dict(torch.load(tmp_path / 'ck.pt', weights_only=False))
    for x, y in zip(a.state_dict()['critic'].values(), b.state_dict()['critic'].values()):
        assert torch.equal(x, y)
    assert b.updates == 4 and torch.equal(a.obs_inv_std, b.obs_inv_std)
    # the same updates from the same state and RNG give the same networks (optimiser state included)
    for x in (a, b):
        x.replay = filled_buffer('cpu')
        torch.manual_seed(5)
        x.update(3)
    for x, y in zip(a.actor.parameters(), b.actor.parameters()):
        assert torch.equal(x, y)
    for x, y in zip(a.target.parameters(), b.target.parameters()):
        assert torch.equal(x, y)
    assert a.log_alpha.item() == b.log_alpha.item()


@pytest.mark.parametrize('kind', ['simba', 'mlp'])
def test_numpy_export_matches_torch(tmp_path, kind):
    a = agent(actor=NetConfig(kind=kind, hidden=32, blocks=2, mlp_layers=[32, 24]))
    a.update(3)
    a.set_obs_stats(np.linspace(-1, 1, D), np.linspace(0.05, 2, D))
    a.export_policy(tmp_path / 'p.npz')
    pol = NumpyPolicy(tmp_path / 'p.npz')
    obs = np.random.default_rng(1).standard_normal((64, D)).astype(np.float32) * 3
    want = a.act(obs, deterministic=True)
    np.testing.assert_allclose(pol(obs), want, atol=1e-5)
    np.testing.assert_allclose(pol(obs[0]), want[0], atol=1e-5)
    cpu = CpuPolicy(a.cfg, D, A)
    cpu.load(a.policy_state())
    np.testing.assert_allclose(cpu(obs, deterministic=True), want, atol=1e-6)


def test_deterministic_act():
    a = agent()
    obs = np.random.default_rng(2).standard_normal((9, D)).astype(np.float32)
    x, y = a.act(obs), a.act(obs)
    np.testing.assert_array_equal(x, y)
    o = torch.from_numpy(obs)
    np.testing.assert_allclose(x, torch.tanh(a.actor.dist(o)[0]).detach().numpy(), atol=1e-6)
    assert not np.array_equal(a.act(obs, deterministic=False), x)


def test_running_stats_and_floor():
    rs = RunningStats(3, floor=0.05)
    rng = np.random.default_rng(0)
    data = np.concatenate([rng.normal(2, 3, (500, 3)), rng.normal(2, 3, (300, 3))])
    data[:, 2] = 1.0  # a constant input
    rs.update(data[:500])
    rs.update(data[500:])
    np.testing.assert_allclose(rs.mean, data.mean(0))
    np.testing.assert_allclose(rs.std()[:2], data[:, :2].std(0))
    assert rs.std()[2] == 0.05


@pytest.mark.skipif(not torch.cuda.is_available(), reason='needs CUDA')
@pytest.mark.parametrize('amp,compile', [('off', False), ('bf16', False), ('bf16', True)])
def test_cuda_graph_updates(amp, compile):
    a = agent('cuda', cuda_graph=True, amp=amp, compile=compile, policy_delay=2)
    a.update(10)
    a.update(10)
    m = a.read_metrics()
    assert all(np.isfinite(v) for v in m.values()), m
    assert a.updates == 20
    # load_state_dict copies in place: the captured graphs train the loaded weights
    state = {k: (v.clone() if torch.is_tensor(v) else v) for k, v in a.state_dict().items()}
    w = a.actor.head.weight
    a.load_state_dict(state)
    assert a.actor.head.weight is w
    before = w.detach().clone()
    a.update(4)
    assert not torch.equal(before, a.actor.head.weight)


def test_load_act_fn_from_checkpoint_and_export(tmp_path):
    from config import TrainConfig, to_dict
    from sac import load_act_fn
    a = agent()
    a.update(2)
    a.set_obs_stats(np.linspace(-1, 1, D), np.linspace(0.5, 2, D))
    cfg = TrainConfig(sac=a.cfg)
    torch.save({'config': to_dict(cfg), 'obs_dim': D, 'act_dim': A, 'policy': a.policy_state()}, tmp_path / 'ck.pt')
    a.export_policy(tmp_path / 'p.npz')
    obs = np.random.default_rng(3).standard_normal((5, D)).astype(np.float32)
    want = a.act(obs)
    np.testing.assert_allclose(load_act_fn(tmp_path / 'ck.pt')(obs), want, atol=1e-6)
    np.testing.assert_allclose(load_act_fn(tmp_path / 'p.npz')(obs), want, atol=1e-5)


def test_rate_regulariser_pulls_the_mean_to_the_previous_action():
    """With the critic's say removed (zero Q gradient is not available, so a large weight instead), the actor's mean
    action moves to the previous action held in the observation."""
    torch.manual_seed(0)
    a = agent(rate_reg=[50.0, 50.0], prev_action_index=[3, 4])
    obs = torch.randn(256, D, device=a.device)
    obs[:, 3:5] = torch.rand(256, 2, device=a.device) * 1.6 - 0.8
    before = (a.actor.deterministic(a.norm(obs)) - obs[:, 3:5]).abs().mean().item()
    for _ in range(300):
        loss, _, _, _, rate = a.actor_loss(obs)
        a.actor_opt.zero_grad()
        loss.backward()
        a.actor_opt.step()
    after = (a.actor.deterministic(a.norm(obs)) - obs[:, 3:5]).abs().mean().item()
    assert after < 0.25 * before and abs(rate.item() - after) < 0.05
    with pytest.raises(ValueError):
        agent(rate_reg=[1.0, 1.0])   # no prev_action_index


def test_averaged_actor_and_learning_rates_on_load():
    a = agent(actor_ema=0.9)
    start = [p.clone() for p in a.actor.parameters()]
    a.update(5)
    live, avg = list(a.actor.parameters()), list(a.actor_ema.parameters())
    # after one call of 5 updates the average has moved 1 - 0.9^5 of the way from the start to the live actor
    w = 1 - 0.9 ** 5
    for s, l, e in zip(start, live, avg):
        torch.testing.assert_close(e, s + w * (l - s), atol=1e-6, rtol=1e-5)
    assert 'actor_ema' in a.policy_state() and 'actor_ema' not in agent().policy_state()
    b = agent(actor_ema=0.9, lr_actor=1e-5)
    old = {k: v for k, v in a.state_dict().items() if k != 'actor_ema'}   # a checkpoint from before the average
    b.load_state_dict(old)
    for l, e in zip(a.actor.parameters(), b.actor_ema.parameters()):
        torch.testing.assert_close(e, l)
    assert b.actor_opt.param_groups[0]['lr'] == 1e-5
