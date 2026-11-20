#!/bin/sh
# Fine-tunes a circuit's specialist from a many-circuit run: ./specialist.sh <base run> <car> <track> <steps> [train.py arguments]
# The new run runs/<car>_<track> starts from the base run's latest.pt (its config and worker too) on that circuit
# alone, evaluates four laps there every four minutes (three with action noise) and stops after <steps> env steps.
cd "$(dirname "$0")" && base=$1 && car=$2 && track=$3 && steps=$4 && shift 4 && name="${car}_${track}" &&
mkdir -p "runs/$name" && cp "runs/$base/latest.pt" "runs/$base/config.json" "runs/$base/worker.mjs" "runs/$name/" &&
start=$(.venv/bin/python -c "import torch,sys; print(torch.load(sys.argv[1], weights_only=False, map_location='cpu')['env_steps'])" "runs/$name/latest.pt") &&
exec .venv/bin/python train.py --name "$name" --resume \
  --set "env.reset.tracks=[\"$track\"]" --set "env.reset.cars=[\"$car\"]" --set 'eval.combos=[]' --set eval.repeats=4 \
  --set eval.every_secs=240 --set eval.num_workers=1 --set collect.learning_starts=100000 \
  --set "max_env_steps=$((start + steps))" "$@" >> "runs/$name.out" 2>&1
