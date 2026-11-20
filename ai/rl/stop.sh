#!/bin/sh
# Stops a run started by run.sh and waits for it to save and exit.
cd "$(dirname "$0")" && pid=$(cat "runs/$1.pid") && kill -TERM "$pid" && while kill -0 "$pid" 2>/dev/null; do sleep 1; done
tail -1 "runs/$1.out"
