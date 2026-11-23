#!/bin/sh
# The smoothness round, one circuit after another: ./rate_round.sh <car> <track> [track ...]
#
# Each circuit's specialist is continued from its latest long-episode round (runs/<car>_<track>_s3, _s2 or _s) for
# 4.5M steps (about 45 minutes) with the absolute action-rate penalty (reward.py: 2 m per unit of steering, 0.5 m per
# unit of pedal), 900 s episodes, five-lap stint evaluations and every clean checkpoint kept, as
# runs/<car>_<track>_rate. A circuit whose round has finished is skipped, so the same command resumes a list after an
# interruption (delete a half-finished circuit's runs/<car>_<track>_rate folder and .out first). Progress:
# runs/rate.log. Then: install_specialists.py <car> --tracks ... --suffix _rate --stint 6 --laps 4 --force
#
#   setsid nohup ./rate_round.sh lcgt3 monza madrid ... > runs/rate.err 2>&1 &
cd "$(dirname "$0")" && car=$1 && shift
for t in "$@"; do
  if grep -q '^stopped at' "runs/${car}_${t}_rate.out" 2>/dev/null; then continue; fi
  from=_s; for s in _s2 _s3; do [ -f "runs/${car}_${t}${s}/latest.pt" ] && from=$s; done
  echo "$(date +%H:%M) $t: start (from ${car}_${t}${from})" >> runs/rate.log
  FROM=$from TO=_rate ./refine.sh "$car" "$t" 4500000 --set sac.actor_obs_noise=0.05 --set env.episodeSecs=900 \
    --set eval.laps=5 --set eval.repeats=4 --set eval.every_secs=300 --set eval.keep_clean=true \
    --set 'reward={"off_event":10.0,"pit_event":10.0,"wall_event":5.0,"steer_rate":2.0,"pedal_rate":0.5}'
  echo "$(date +%H:%M) $t: $(tail -1 "runs/${car}_${t}_rate.out" | cut -c1-40)" >> runs/rate.log
done
echo "$(date +%H:%M) all done" >> runs/rate.log
