#!/bin/sh
# Another round for a circuit's specialist: ./refine.sh <car> <track> <steps> [train.py arguments]
# runs/<car>_<track>_r2 continues runs/<car>_<track>/latest.pt (the best score forgotten, so the round keeps its own
# best) with eight-lap evaluations and 10 s excursion events; install_specialists.py --suffix _r2 installs it if it
# validates clean and quicker than the installed one.
cd "$(dirname "$0")" && car=$1 && track=$2 && steps=$3 && shift 3 && from="runs/${car}_${track}" && name="${car}_${track}_r2" &&
mkdir -p "runs/$name" && cp "$from/config.json" "$from/worker.mjs" "runs/$name/" &&
start=$(.venv/bin/python -c "
import math, sys, torch
ck = torch.load(sys.argv[1] + '/latest.pt', weights_only=False, map_location='cpu')
ck['best_score'] = math.inf
torch.save(ck, sys.argv[2] + '/latest.pt')
print(ck['env_steps'])" "$from" "runs/$name") &&
exec .venv/bin/python train.py --name "$name" --resume --set eval.repeats=8 --set eval.num_workers=2 \
  --set 'reward={"off_event":10.0,"pit_event":10.0,"wall_event":5.0}' --set "max_env_steps=$((start + steps))" "$@" >> "runs/$name.out" 2>&1
