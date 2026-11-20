"""Prints a run's evaluations, one line each: python summarize.py runs/<name> [last N]"""
import json
import sys

run, last = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0
lines = [json.loads(l) for l in open(f'{run}/eval.jsonl')]
t0 = lines[0]['time'] if lines else 0
best = {}
for d in lines[-last:]:
    out = [f"{(d['time'] - t0) / 60:6.0f} min {d['env_steps'] / 1e6:6.2f}M"]
    for r in d['results']:
        lap = f"{r['lap_time']:8.3f}" if r['lap_time'] else '       -'
        flag = 'ok ' if r['lap_valid'] else ('INV' if r['lap_time'] else r['end_reason'][:3])
        out.append(f"{r['track'][:9]}/{r['car']} {lap} {flag} wall {r['wall_contact_steps']:3d} off {r['off_track_time']:5.2f}")
    print('  '.join(out))
for d in lines:
    for r in d['results']:
        if r['lap_valid'] and r['lap_time'] and not r['wall_contact_steps']:
            k = (r['track'], r['car'])
            best[k] = min(best.get(k, 1e9), r['lap_time'])
print('best clean valid laps:', {f'{t}/{c}': round(v, 3) for (t, c), v in best.items()})
