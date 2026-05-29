#!/usr/bin/env bash
# Starts all local services the minimal-playground needs.
#   2023  whisper-server   (native whisper.cpp, /inference, WAV only)
#   2022  whisper-bridge   (webm/wav -> wav, OpenAI-compatible /v1/audio/transcriptions)
#   5001  piper-warm       (official piper.http_server, model kept in memory)
#   5000  piper-proxy      (CORS proxy: POST /api/tts -> piper-warm)
#   8011  static server    (serves repo root so /dist and /node_modules resolve)
#
# Logs go to ./.logs/*.log. Re-running frees the ports first, so it is safe to repeat.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p .logs

PIPER_PY="${PIPER_PY:-$HOME/.local/pipx/venvs/piper-tts/bin/python}"
PIPER_VOICES="${PIPER_VOICES:-$ROOT/examples/piper-http-server/voices}"
PIPER_MODEL="${PIPER_MODEL:-$PIPER_VOICES/en_US-lessac-medium.onnx}"
WHISPER_DIR="${WHISPER_DIR:-$ROOT/vendor/whisper.cpp}"
WHISPER_MODEL="${WHISPER_MODEL:-models/ggml-base.en.bin}"

free_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true; }
wait_port() { for _ in $(seq 1 80); do lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }

echo "Freeing ports 2022 2023 5000 5001 8011 ..."
for p in 2022 2023 5000 5001 8011; do free_port "$p"; done
sleep 0.5

echo "[2023] whisper-server"
( cd "$WHISPER_DIR" && nohup ./build/bin/whisper-server -m "$WHISPER_MODEL" --port 2023 --host 127.0.0.1 ) \
  >.logs/whisper-server.log 2>&1 &
wait_port 2023 && echo "      up" || { echo "      FAILED (see .logs/whisper-server.log)"; exit 1; }

echo "[2022] whisper-bridge"
nohup node examples/whisper-bridge/server.mjs >.logs/whisper-bridge.log 2>&1 &
wait_port 2022 && echo "      up" || { echo "      FAILED (see .logs/whisper-bridge.log)"; exit 1; }

echo "[5001] piper-warm (loads model into memory)"
nohup "$PIPER_PY" -m piper.http_server -m "$PIPER_MODEL" --data-dir "$PIPER_VOICES" \
  --host 127.0.0.1 --port 5001 >.logs/piper-warm.log 2>&1 &
wait_port 5001 && echo "      up" || { echo "      FAILED (see .logs/piper-warm.log)"; exit 1; }

echo "[5000] piper-proxy"
nohup node examples/piper-http-server/server.mjs >.logs/piper-proxy.log 2>&1 &
wait_port 5000 && echo "      up" || { echo "      FAILED (see .logs/piper-proxy.log)"; exit 1; }

echo "[8011] static server"
nohup python3 -m http.server 8011 --bind 127.0.0.1 >.logs/static.log 2>&1 &
wait_port 8011 && echo "      up" || { echo "      FAILED (see .logs/static.log)"; exit 1; }

echo
echo "All services up. Open:"
echo "  http://127.0.0.1:8011/examples/minimal-playground/index.html"
echo
echo "Stop everything with: ./stop-services.sh   (or kill the ports manually)"
