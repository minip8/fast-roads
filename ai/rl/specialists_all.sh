#!/bin/sh
# One specialist after another: ./specialists_all.sh <base run> <car> <steps> <track> [track ...]
# (each as specialist.sh runs it; a circuit that already has a finished run is skipped). Progress: runs/specialists.log
cd "$(dirname "$0")" && base=$1 && car=$2 && steps=$3 && shift 3
for track in "$@"; do
  if grep -q '^stopped at' "runs/${car}_${track}.out" 2>/dev/null; then echo "$(date +%H:%M) $track: already done" >> runs/specialists.log; continue; fi
  echo "$(date +%H:%M) $track: start" >> runs/specialists.log
  ./specialist.sh "$base" "$car" "$track" "$steps" --set 'reward={"off_event":5.0,"pit_event":5.0,"wall_event":5.0}'
  echo "$(date +%H:%M) $track: $(tail -1 "runs/${car}_${track}.out" | cut -c1-60)" >> runs/specialists.log
done
echo "$(date +%H:%M) all done" >> runs/specialists.log
