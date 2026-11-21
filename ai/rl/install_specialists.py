"""Validates the circuit specialists of a car (runs/<car>_<track>/best.npz, from specialist.sh) and installs them in the
game: python install_specialists.py lcgt3 [--laps 12] [--tracks a,b] [--suffix _r2] [--dry]

Each policy laps its circuit --laps times, the first as it drives and the others with action noise (as the training
evaluation does, with more laps). One that is clean every time (valid, no wall contact) is exported to
public/ai/<car>-<track>.bin and named in policies.json for its circuit; the others are reported and left to the car's
default policy. With --suffix the runs are runs/<car>_<track><suffix> (a later round, refine.sh), and one replaces the
installed specialist only if it is also quicker (the median of its validation laps against the installed file's).
The table goes to stdout."""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

import export_web
from evaluate import evaluate_laps, pinned_laps
from policy_np import NumpyPolicy

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent.parent / 'public' / 'ai'


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('car')
    ap.add_argument('--laps', type=int, default=12)
    ap.add_argument('--noise', type=float, default=0.003)
    ap.add_argument('--tracks', default='', help='comma-separated (default: every circuit with a run)')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--suffix', default='', help="runs are runs/<car>_<track><suffix>")
    ap.add_argument('--dry', action='store_true', help='validate only')
    args = ap.parse_args()
    car, pinned = args.car, pinned_laps()
    tracks = args.tracks.split(',') if args.tracks else [t for (t, c) in pinned if c == car]
    manifest_path = PUBLIC / 'policies.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    entry = manifest.setdefault(car, {})
    special = entry.setdefault('tracks', {})
    print(f"{'circuit':<12} {'lap':>8} {'clean':>6} {'median':>8} {'worst':>8} {'autopilot':>9}  installed")
    for track in tracks:
        run = HERE / 'runs' / f'{car}_{track}{args.suffix}'
        if not (run / 'best.npz').exists():
            print(f'{track:<12} no run')
            continue
        cfg = json.loads((run / 'config.json').read_text())
        res = evaluate_laps(NumpyPolicy(run / 'best.npz'), [(track, car)] * args.laps, config=cfg.get('env', {}),
                            num_workers=args.workers, noise=[0.0] + [args.noise] * (args.laps - 1),
                            worker_path=str(run / 'worker.mjs'), seed=11)
        ok = [r['lap_time'] for r in res if r['lap_valid'] and r['lap_time'] and not r['wall_contact_steps']]
        good = len(ok) == len(res)
        name = f'{car}-{track}.bin'
        if good and args.suffix and special.get(track) and (PUBLIC / name).exists():   # quicker than the installed one?
            note = export_web.unpack((PUBLIC / name).read_bytes())[0]['provenance'].get('note', '')
            m = re.search(r'median ([\d.]+) s', note)
            good = not m or statistics.median(ok) < float(m.group(1))
        if good and not args.dry:
            export_web.main(['--run', str(run), '--out', str(PUBLIC / name), '--worker', str(run / 'worker.mjs'),
                             '--note', f'{track} specialist; {len(ok)}/{len(res)} validation laps clean, median '
                                       f'{statistics.median(ok):.3f} s'])
            special[track] = name
        elif not good and not args.dry and not args.suffix:
            special.pop(track, None)
        lap = res[0]['lap_time']
        print(f"{track:<12} {lap if lap is None else format(lap, '8.3f')} {len(ok):>3}/{len(res):<2} "
              f"{statistics.median(ok) if ok else float('nan'):8.3f} {max(ok) if ok else float('nan'):8.3f} "
              f"{pinned.get((track, car), float('nan')):9.3f}  {'yes' if good and not args.dry else 'no'}", flush=True)
    if not args.dry:
        manifest_path.write_text(json.dumps(manifest, indent=1) + '\n')


if __name__ == '__main__':
    sys.exit(main())
