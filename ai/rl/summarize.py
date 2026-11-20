"""Prints a run's evaluations, one line each: python summarize.py runs/<name> [last N]

Per (track, car): the lap as the policy drives it, then over all its repeats (the others have action noise) how many
were clean (valid, no wall contact) and their median. With many combos, one line per evaluation instead: how many
combos had a clean lap as driven, how many had every repeat clean, and the mean of lap time / the autopilot's pinned
lap over the clean ones; then the last evaluation combo by combo."""
import json
import statistics
import sys

from evaluate import pinned_laps

run, last = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0
lines = [json.loads(l) for l in open(f'{run}/eval.jsonl')]
t0 = lines[0]['time'] if lines else 0
clean = lambda r: bool(r['lap_valid'] and r['lap_time'] and not r['wall_contact_steps'])
pinned = pinned_laps()
best = {}


def one(track, car, rs):
    r = rs[0]
    lap = f"{r['lap_time']:8.3f}" if r['lap_time'] else '       -'
    flag = 'ok ' if r['lap_valid'] else ('INV' if r['lap_time'] else r['end_reason'][:3])
    text = f"{track[:11]:<11} {car:<5} {lap} {flag} wall {r['wall_contact_steps']:3d} off {r['off_track_time']:5.2f}"
    if r.get('pit_lane_time'):
        text += f" pit {r['pit_lane_time']:.2f}"
    ok = [x['lap_time'] for x in rs if clean(x)]
    if len(rs) > 1:
        text += f"  clean {len(ok)}/{len(rs)}" + (f" median {statistics.median(ok):.3f}" if ok else '')
    if (track, car) in pinned:
        text += f"  autopilot {pinned[(track, car)]:.3f}"
    return text


for n, d in enumerate(lines):
    head = f"{(d['time'] - t0) / 60:6.0f} min {d['env_steps'] / 1e6:6.2f}M"
    groups = {}
    for r in d['results']:
        groups.setdefault((r['track'], r['car']), []).append(r)
    for (track, car), rs in groups.items():
        ok = [x['lap_time'] for x in rs if clean(x)]
        if len(ok) == len(rs):
            m = statistics.mean(ok)
            if m < best.get((track, car), (1e9,))[0]:
                best[(track, car)] = (round(m, 3), f"{d['env_steps'] / 1e6:.2f}M")
    if last and n < len(lines) - last:
        continue
    if len(groups) <= 3:
        print(head + '  ' + '  '.join(one(t, c, rs) for (t, c), rs in groups.items()))
    else:
        first = [k for k, rs in groups.items() if clean(rs[0])]
        every = sum(all(clean(x) for x in rs) for rs in groups.values())
        ratio = [groups[k][0]['lap_time'] / pinned[k] for k in first if k in pinned]
        print(f"{head}  clean as driven {len(first)}/{len(groups)}, every repeat {every}/{len(groups)}"
              + (f", lap / autopilot {statistics.mean(ratio):.4f}" if ratio else ''))
if lines and len(groups) > 3:
    for (t, c), rs in groups.items():
        print('   ', one(t, c, rs))
print('best mean lap with every repeat clean:', {f'{t}/{c}': v for (t, c), v in best.items()})
