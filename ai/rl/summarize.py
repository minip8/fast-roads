"""Prints a run's evaluations, one line each: python summarize.py runs/<name> [last N]

Per (track, car): the lap as the policy drives it, then over all its repeats (the others have action noise) how many
were clean (valid, no wall contact) and their median."""
import json
import statistics
import sys

run, last = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0
lines = [json.loads(l) for l in open(f'{run}/eval.jsonl')]
t0 = lines[0]['time'] if lines else 0
clean = lambda r: bool(r['lap_valid'] and r['lap_time'] and not r['wall_contact_steps'])
best = {}
for n, d in enumerate(lines):
    out = [f"{(d['time'] - t0) / 60:6.0f} min {d['env_steps'] / 1e6:6.2f}M"]
    groups = {}
    for r in d['results']:
        groups.setdefault((r['track'], r['car']), []).append(r)
    for (track, car), rs in groups.items():
        r = rs[0]
        lap = f"{r['lap_time']:8.3f}" if r['lap_time'] else '       -'
        flag = 'ok ' if r['lap_valid'] else ('INV' if r['lap_time'] else r['end_reason'][:3])
        text = f"{track[:9]}/{car} {lap} {flag} wall {r['wall_contact_steps']:3d} off {r['off_track_time']:5.2f}"
        ok = [x['lap_time'] for x in rs if clean(x)]
        if len(rs) > 1:
            text += f"  clean {len(ok)}/{len(rs)}" + (f" median {statistics.median(ok):.3f}" if ok else '')
        if len(ok) == len(rs):
            k = f'{track}/{car}'
            m = statistics.mean(ok)
            if m < best.get(k, (1e9,))[0]:
                best[k] = (round(m, 3), f"{d['env_steps'] / 1e6:.2f}M")
        out.append(text)
    if not last or n >= len(lines) - last:
        print('  '.join(out))
print('best mean lap with every repeat clean:', best)
