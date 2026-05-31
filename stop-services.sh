#!/usr/bin/env bash
# Stops the minimal-playground services by freeing their ports.
# (5001 = legacy piper-warm, kept here so old runs are cleaned up too.)
set -euo pipefail
for p in 2022 2023 5000 5001 5002 5003 8011; do
  pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then echo "port $p: killing $pids"; echo "$pids" | xargs -r kill 2>/dev/null || true; else echo "port $p: not running"; fi
done
