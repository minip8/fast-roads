#!/bin/sh
# A second round for one specialist after another: ./refine_all.sh <car> <steps> <track> [track ...] -- [train.py arguments]
# (refine.sh each; a circuit whose round has finished is skipped). Progress: runs/refine.log
cd "$(dirname "$0")" && car=$1 && steps=$2 && shift 2
tracks=""; while [ $# -gt 0 ] && [ "$1" != "--" ]; do tracks="$tracks $1"; shift; done; [ "$1" = "--" ] && shift
for track in $tracks; do
  if grep -q '^stopped at' "runs/${car}_${track}_r2.out" 2>/dev/null; then echo "$(date +%H:%M) $track: already done" >> runs/refine.log; continue; fi
  echo "$(date +%H:%M) $track: start" >> runs/refine.log
  ./refine.sh "$car" "$track" "$steps" "$@"
  echo "$(date +%H:%M) $track: $(tail -1 "runs/${car}_${track}_r2.out" | cut -c1-40)" >> runs/refine.log
done
echo "$(date +%H:%M) all done" >> runs/refine.log
