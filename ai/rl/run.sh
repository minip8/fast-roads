#!/bin/sh
# Starts a training run detached: ./run.sh <name> [train.py arguments]; its output goes to runs/<name>.out and its
# process id to runs/<name>.pid (stop it with ./stop.sh <name>: SIGTERM saves latest.pt and closes the workers).
cd "$(dirname "$0")" && mkdir -p runs && name=$1 && shift &&
setsid nohup .venv/bin/python train.py --name "$name" "$@" >> "runs/$name.out" 2>&1 &
echo $! > "$(dirname "$0")/runs/$1.pid"
