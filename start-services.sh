#!/usr/bin/env bash
# Starts all local services the minimal-playground needs.
#   2023  whisper-server   (native whisper.cpp, /inference, WAV only)
#   2022  whisper-bridge   (webm/wav -> wav, OpenAI-compatible /v1/audio/transcriptions)
#   5002  kokoro-warm      (Kokoro TTS, model kept in memory; JSON / -> WAV)
#   5000  tts-proxy        (CORS proxy: POST /api/tts -> kokoro-warm)
#   8011  static server    (serves repo root so /dist and /node_modules resolve)
#
# Logs go to ./.logs/*.log. Re-running frees the ports first, so it is safe to repeat.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p .logs

KOKORO_PY="${KOKORO_PY:-$ROOT/vendor/kokoro/venv/bin/python}"
KOKORO_MODEL="${KOKORO_MODEL:-$ROOT/vendor/kokoro/models/kokoro-v1.0.onnx}"
KOKORO_VOICES="${KOKORO_VOICES:-$ROOT/vendor/kokoro/models/voices-v1.0.bin}"
KOKORO_VOICE="${KOKORO_VOICE:-af_heart}"
WHISPER_DIR="${WHISPER_DIR:-$ROOT/vendor/whisper.cpp}"
WHISPER_MODEL="${WHISPER_MODEL:-models/ggml-small.en.bin}"

free_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true; }
wait_port() { for _ in $(seq 1 120); do lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }

echo "Freeing ports 2022 2023 5000 5002 8011 ..."
for p in 2022 2023 5000 5002 8011; do free_port "$p"; done
sleep 0.5

echo "[2023] whisper-server"
( cd "$WHISPER_DIR" && nohup ./build/bin/whisper-server -m "$WHISPER_MODEL" --port 2023 --host 127.0.0.1 ) \
  >.logs/whisper-server.log 2>&1 &
wait_port 2023 && echo "      up" || { echo "      FAILED (see .logs/whisper-server.log)"; exit 1; }

echo "[2022] whisper-bridge"
nohup node examples/whisper-bridge/server.mjs >.logs/whisper-bridge.log 2>&1 &
wait_port 2022 && echo "      up" || { echo "      FAILED (see .logs/whisper-bridge.log)"; exit 1; }

echo "[5002] kokoro-warm (loads model into memory; takes a few seconds)"
KOKORO_MODEL="$KOKORO_MODEL" KOKORO_VOICES="$KOKORO_VOICES" KOKORO_VOICE="$KOKORO_VOICE" PORT=5002 \
  nohup "$KOKORO_PY" examples/kokoro-http-server/server.py >.logs/kokoro.log 2>&1 &
wait_port 5002 && echo "      up" || { echo "      FAILED (see .logs/kokoro.log)"; exit 1; }

echo "[5000] tts-proxy -> kokoro"
PIPER_BACKEND="http://127.0.0.1:5002/" PIPER_DEFAULT_VOICE="$KOKORO_VOICE" \
  nohup node examples/piper-http-server/server.mjs >.logs/tts-proxy.log 2>&1 &
wait_port 5000 && echo "      up" || { echo "      FAILED (see .logs/tts-proxy.log)"; exit 1; }

echo "[8011] static server"
nohup python3 -m http.server 8011 --bind 127.0.0.1 >.logs/static.log 2>&1 &
wait_port 8011 && echo "      up" || { echo "      FAILED (see .logs/static.log)"; exit 1; }

echo
echo "All services up. Open:"
echo "  http://127.0.0.1:8011/examples/minimal-playground/index.html"
echo
echo "Stop everything with: ./stop-services.sh   (or kill the ports manually)"
