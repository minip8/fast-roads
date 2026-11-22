"""Converts a trained policy (`.npz`, layout in policy_np.py) into the game's web policy file: one binary the browser
fetches and parses without a zip library (src/ai/policy.ts reads it; docs/ai-env.md, "Trained policies in the game").

    python export_web.py --run runs/mel_f1_a --out ../../public/ai/lcf1-melbourne.bin
    python export_web.py --run runs/smoke --policy best.npz --out /tmp/p.bin --note 'first valid lap'

Layout (little-endian):
    0   4 bytes   b'FRPW'
    4   u32       J, the JSON's byte length
    8   J bytes   UTF-8 JSON (below)
    zeros to a multiple of 4 bytes
    float32[]     the arrays, back to back, each at meta['arrays'][name]['offset'] floats from here

JSON: {"format": "fast-roads-policy-web", "version": 1, "obs_dim", "act_dim", "obs_clip", "obsVersion", "ops" (as in
the .npz), "output", "arrays": {name: {"offset", "shape"}}, "env": the run's effective environment config (its
`config.json` `env`, with the env's own penalties off when the run used the trainer's reward as train.py does, merged
over the environment's defaults, as the worker reported it in READY: actionHz,
actionMode, deltaScale, steerRate, pedalRate, tc, obs... are what the game drives with), "trained": {"cars",
"tracks"}, "provenance": {run, policy, sha256, env steps and the evaluated laps of that policy, worker build, note}}.

The effective config comes from an env worker (build/env/worker.mjs, or --worker): one is started with the run's env
config and asked (INIT -> READY, one environment, nothing stepped), so the defaults are the environment's own, never
a copy of them here. The evaluation recorded for the policy is the last improving line of the run's eval.jsonl
(best.npz is rewritten whenever the score improves); for another policy file pass --eval-line or nothing is recorded.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import merge  # noqa: E402
from policy_np import NumpyPolicy  # noqa: E402
from reward import ENV_REWARD  # noqa: E402

MAGIC = b'FRPW'
FORMAT = 'fast-roads-policy-web'


def pack(meta: dict, arrays: dict[str, np.ndarray]) -> bytes:
    """The web policy file for an .npz's meta (obs_dim, act_dim, obs_clip, ops, output) and arrays, plus the extra
    keys in `meta` (obsVersion, env, trained, provenance) copied as they are."""
    out = {k: v for k, v in meta.items() if k not in ('format', 'version')}
    out = {'format': FORMAT, 'version': 1, **out, 'arrays': {}}
    names = ['obs_mean', 'obs_scale'] + [n for n in arrays if n not in ('obs_mean', 'obs_scale')]
    blobs, offset = [], 0
    for name in names:
        a = np.ascontiguousarray(arrays[name], dtype='<f4')
        out['arrays'][name] = {'offset': offset, 'shape': list(a.shape)}
        blobs.append(a.tobytes())
        offset += a.size
    js = json.dumps(out, separators=(',', ':')).encode('utf-8')
    head = MAGIC + struct.pack('<I', len(js)) + js
    head += b'\0' * (-len(head) % 4)
    return head + b''.join(blobs)


def unpack(data: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    """The inverse of pack (for checks)."""
    if data[:4] != MAGIC:
        raise ValueError('not a web policy file')
    (j,) = struct.unpack_from('<I', data, 4)
    meta = json.loads(data[8:8 + j].decode('utf-8'))
    base = (8 + j + 3) & ~3
    arrays = {}
    for name, spec in meta['arrays'].items():
        n = int(np.prod(spec['shape']))
        arrays[name] = np.frombuffer(data, '<f4', n, base + 4 * spec['offset']).reshape(spec['shape'])
    return meta, arrays


def effective_env(env: dict, worker: str | None) -> tuple[dict, dict, dict]:
    """(config, READY, HELLO) of an env worker INITed with `env` (one environment, nothing stepped)."""
    from envpool import EnvPool
    with EnvPool(1, 1, env, worker_path=worker) as pool:
        return pool.config, pool.ready, pool.hello


def eval_record(run: Path, policy: Path, line: int | None) -> dict | None:
    """The eval.jsonl entry that produced `policy`: the given line (1-based), for best.npz the last improving one, for
    a clean-<env steps>.npz the one at those steps."""
    path = run / 'eval.jsonl'
    if not path.exists():
        return None
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    if line is not None:
        return rows[line - 1]
    if policy.name.startswith('clean-'):   # clean-<env steps>.npz (eval.keep_clean): that evaluation
        steps = int(policy.stem.split('-')[1])
        return next((r for r in reversed(rows) if r.get('env_steps') == steps), None)
    if policy.name != 'best.npz':
        return None
    best = [r for r in rows if r.get('best')]
    return best[-1] if best else None


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run', required=True, help='the run folder (holds config.json, eval.jsonl and the policy)')
    ap.add_argument('--policy', default='best.npz', help='policy file in the run folder (default best.npz), or a path')
    ap.add_argument('--out', required=True, help='the web policy file to write')
    ap.add_argument('--note', default='', help='free text kept in the provenance')
    ap.add_argument('--worker', default=None, help='env worker to ask for the effective config (default build/env/worker.mjs)')
    ap.add_argument('--eval-line', type=int, default=None, help="eval.jsonl line (1-based) that evaluated this policy")
    args = ap.parse_args(argv)

    run = Path(args.run)
    policy_path = Path(args.policy) if os.sep in args.policy or Path(args.policy).is_absolute() else run / args.policy
    # A live run rewrites best.npz, then appends its eval line, whenever it improves: read the file once, between two
    # reads of eval.jsonl that agree, and not within seconds of a rewrite, so the evaluation recorded is this file's.
    for _ in range(10):
        ev = eval_record(run, policy_path, args.eval_line)
        mtime = policy_path.stat().st_mtime
        raw = policy_path.read_bytes()
        if time.time() - mtime > 5 and eval_record(run, policy_path, args.eval_line) == ev and policy_path.stat().st_mtime == mtime:
            break
        time.sleep(3)
    else:
        sys.exit(f'{policy_path} keeps changing: try again')
    pol = NumpyPolicy(io.BytesIO(raw))  # (np.load takes a file object)
    cfg = json.loads((run / 'config.json').read_text())
    # the env config the collectors ran (train.make_env_pool): with the trainer's own reward, the env's penalties off
    env = cfg.get('env', {}) if cfg.get('reward') is None else merge(cfg.get('env', {}), {'reward': ENV_REWARD})
    config, ready, hello = effective_env(env, args.worker)
    if ready['obsSize'] != pol.obs_dim:
        sys.exit(f"{policy_path}: the policy observes {pol.obs_dim} values, the environment ({config['obs']}) {ready['obsSize']}")
    provenance = {
        'run': run.resolve().name, 'policy': policy_path.name, 'sha256': hashlib.sha256(raw).hexdigest(),
        'exported': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'policy_mtime': time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(mtime)),
        'actor': cfg.get('sac', {}).get('actor'), 'obs_norm': cfg.get('sac', {}).get('obs_norm'),
        'reward': cfg.get('reward'),
        'worker': hello.get('game'),
        'note': args.note,
    }
    if ev:
        provenance['env_steps'] = ev.get('env_steps')
        # (laps: a stint evaluation's laps as [time, valid], lap_time then their mean)
        provenance['eval'] = [{k: r.get(k) for k in ('track', 'car', 'lap_time', 'lap_valid', 'end_reason', 'off_track_time',
                                                     'pit_lane_time', 'wall_contact_steps', 'laps') if k in r}
                              for r in ev.get('results', [])]
    meta = dict(pol.meta, obsVersion=ready['obsVersion'], env=config,
                trained={'cars': config['reset']['cars'], 'tracks': config['reset']['tracks']}, provenance=provenance)
    data = pack(meta, pol.arrays)
    _, back = unpack(data)
    for k, a in pol.arrays.items():
        if not np.array_equal(back[k], a):
            sys.exit(f'round trip changed {k}')
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(out.suffix + '.tmp').write_bytes(data)
    os.replace(out.with_suffix(out.suffix + '.tmp'), out)
    lap = ', '.join(f"{r['track']} {r['car']} {r['lap_time']} ({'valid' if r['lap_valid'] else 'invalid'})"
                    for r in provenance.get('eval', []))
    print(f'{out}: {len(data):,} bytes, obs {pol.obs_dim} (version {ready["obsVersion"]}), {len(pol.meta["ops"])} ops'
          + (f'; evaluated {lap} at {provenance.get("env_steps"):,} env steps' if lap else ''))


if __name__ == '__main__':
    main()
