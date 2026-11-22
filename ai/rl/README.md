# The RL trainer

Trains a time-trial driver for the game by reinforcement learning alone (no demonstrations: the built-in autopilot is
only the baseline), against the environment worker of `docs/ai-env.md`, and installs the result in the game
(`?autopilot=rl`, `public/ai/`). Python 3.13, PyTorch with CUDA, numpy:

    uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python torch numpy gymnasium pytest
    npm run build:env                         # from the repo root: the env worker the pools start
    ./run.sh <name> --config configs/gt3_all.json     # a run, detached: runs/<name>/, runs/<name>.out; ./stop.sh <name>
    .venv/bin/python summarize.py runs/<name>         # its evaluations
    ./specialists_all.sh <base run> lcgt3 3000000 melbourne silverstone ...   # a specialist per circuit from it
    .venv/bin/python stint.py lcgt3 5                 # the installed policies over five laps on end
    .venv/bin/python install_specialists.py lcgt3     # validate each over 12 laps, install the clean ones
    .venv/bin/python -m pytest tests -q               # ~80 s (the Pendulum check: -m sanity)

## What is here

- `envpool.py`: `EnvPool`, N worker processes x M environments as numpy batches. `evaluate.py`: evaluation laps from
  the game's flying start, with repeats under action noise; the autopilot's pinned laps to compare with.
- `replay.py`: the replay buffer on the GPU (one ring per env, observations stored once, n-step returns by gathers at
  sample time). `networks.py`, `sac.py`: SAC with an ensemble of quantile critics (TQC targets), a tanh-Gaussian
  actor; each update a CUDA graph. `train.py`: collector thread, learner, evaluation thread, checkpoints, resume.
- `reward.py`: the training reward, composed from the env's info. `config.py`: every hyperparameter; `configs/`.
- `policy_np.py`, `export_web.py`: the exported policy (`.npz`, and the web file the game loads).
- Tools: `trace_lap.py` + `lap_stats.py` (one lap, step by step: where it lost validity, how it was driven),
  `diag_events.py` (when excursions happen in training conditions), `bench_pool.py`, `bench_agent.py`.

## What was learnt (GT3 and F1, November 2026; one 6-core machine, an RTX 4060, 8 GB of RAM)

The env gives about 1,650 steps/s over 6 workers x 16 envs; the learner 540 updates/s at batch 1,024 with the plain
512x3 critic (190 with the SimBa one), so about one update per three steps. Memory: about 0.3-0.5 GB per worker; keep
`cacheSessions` 1 and `collect.pin` on for many circuits.

- **The entropy weight decides fine control.** Along a lap the critic's value falls by only about 0.85 d^2 (in
  reward x 0.1) for a steering error d, so the auto-tuned temperature (0.016 at target entropy -2) held the policy's
  noise at sigma 0.1 and the steering dithered. A fixed alpha of 0.001 (`init_alpha`, `lr_alpha` 0; GT Sophy's 0.01
  on unscaled metres) fixed the pedal at once and most of the dither.
- **A tanh policy never reaches full throttle**: `action_scale` [1, 1.25] and a clamp put the ends of the pedal at a
  finite pre-activation. Full throttle went from 23-44% of a lap to 81%.
- **Penalties must grow with speed** (Fuchs et al. 2021, GT Sophy), and an excursion must cost once, in seconds
  (`off_event`, `pit_event`, `wall_event`): the game deletes a lap for one tick past the track limits or in the pit
  lane, which a penalty per second barely charges.
- **A regulariser on the mean action** (`rate_reg`) above the critic's action gradient (about 0.1) collapses the
  policy: it then follows its own noise.
- **One policy for 24 circuits is fast but not reliable.** After 83M steps (14 h) the GT3's was at 0.865 of the
  autopilot's lap times, with 1-8 of 24 circuits unclean at every evaluation, a different set each time, whatever the
  event penalty (2 s, 10 s), with the averaged actor (`actor_ema`) and a lower learning rate. It leaves the track
  about once in 15 minutes of driving in training conditions.
- **A specialist per circuit, fine-tuned from it, is both** quicker (1-3%) and clean: 3M steps (30 minutes) each,
  the best four-lap evaluation kept, then validated over 12 laps (11 with action noise): 23 of 24 clean in all 12 at
  the first attempt. Every published superhuman lap is a specialist's too. A second round each (`refine.sh`: 3M more
  steps, 10 s events, eight-lap evaluations, `actor_obs_noise` 0.05) took another 1-2.5% off and steadied them: 20 of
  23 validated clean and quicker (two had one unclean lap in 12, one was no quicker; they keep the first round's).
  The installed GT3 set laps at 0.845 of the autopilot's times on average (0.785 at Madrid to 0.890 at Spielberg).
- **Noise on the actor's input in its own update** (`actor_obs_noise`, GT Sophy's policy dropout in another form)
  made Melbourne's specialist quicker, cleaner and smoother at once (steering reversals on 1,086 steps of a lap
  instead of 1,482; the autopilot's lap has about 200). The steering still dithers: not solved.
- **A lap is chaotic**: actions that differ in the last bit (numpy, torch, the browser's `Math`) give laps tenths
  apart, and a marginal lap valid in one and deleted in another. So: evaluate with repeats under noise, select on
  clean laps before time, and check the installed file in the game (`test/policyLap.ts`).
- **Test what the game does, not what the evaluation does: consecutive laps.** An evaluation episode is one lap from
  the flying start, on tyres at the heat the autopilot leaves them, and training episodes were 90 s from that same
  heat. The policies drive much harder than the autopilot: at Barcelona the front-left's carcass went from below its
  window to twice its top in three laps. Driven on as `?autopilot=rl` drives, 23 of the 24 specialists spun or hit
  a wall on their second or third lap (`stint.py`, `stint_trace.py`). Episodes of 600-900 s (`env.episodeSecs`), so
  that training reaches the heat the policy itself makes, and selection on stints (`eval.laps`) fixed Barcelona's
  in one 3M-step round: 24 laps in four stints clean, 97.0 s for the first and 99.7 s for the slowest (it had gone
  97.0, 99.6, 102.8, 104.8, 106.3). The first lap lost nothing. Validate with `install_specialists.py --stint`.
  For all 24: one round sufficed at 16 circuits, a second (4.5M steps) at four more, a third at the last four (street
  circuits mostly), validated on four six-lap stints each. Checkpoints of one run swing between all clean and
  mostly not from one evaluation to the next, so keep every clean one (`eval.keep_clean`) and let the validation
  pick: at Lusail the round's best drove one clean stint of six and its third clean checkpoint all six.
  `stint.py lcgt3 5` on the installed set: 1 of 24 circuits before, 23 after; `browser_stint.mjs` (three laps in
  headless Chromium): 23 of 24. What is left is about one unclean lap in fifty: twelve laps on end at six circuits
  were 71 clean of 72, lap times level after five or six (Melbourne 110.5 s to 113.6 s), so the policies hold far
  past the 900 s they were trained to. Spa's is installed at 35 clean validation laps of 36.
- A one-circuit policy does not transfer: the F1's Melbourne specialist (93.1 s; the autopilot 116.5 s) finished no
  other circuit.
