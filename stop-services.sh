#!/usr/bin/env bash
# Stops the four minimal-playground services by freeing their ports.
set -euo pipefail
for p in 2022 2023 5000 5001 8011; do
  pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then echo "port $p: killing $pids"; echo "$pids" | xargs -r kill 2>/dev/null || true; else echo "port $p: not running"; fi
done
