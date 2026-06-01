#!/usr/bin/env bash
# Starts all local services the minimal-playground needs.
#   2023  whisper-server   (native whisper.cpp, /inference, WAV only)
#   2022  whisper-bridge   (webm/wav -> wav, OpenAI-compatible /v1/audio/transcriptions)
#   5002  kokoro-warm      (Kokoro TTS for en/hi/ja, model kept in memory; JSON / -> WAV)
#   5003  piper-telugu     (Piper TTS for Telugu; Kokoro has no Telugu voice)
#   5000  tts-proxy        (CORS proxy: POST /api/tts -> kokoro or piper-telugu by voice)
#   8011  static server    (serves repo root so /dist and /node_modules resolve)
#   5005  phone-agent      (optional; outbound Twilio ConversationRelay, only with .env)
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
PIPER_PY="${PIPER_PY:-$HOME/.local/pipx/venvs/piper-tts/bin/python}"
PIPER_VOICES="${PIPER_VOICES:-$ROOT/examples/piper-http-server/voices}"
PIPER_TE_MODEL="${PIPER_TE_MODEL:-$PIPER_VOICES/te_IN-maya-medium.onnx}"
WHISPER_DIR="${WHISPER_DIR:-$ROOT/vendor/whisper.cpp}"
# whisper-server starts on this model; the bridge hot-swaps via /load per request.
WHISPER_MODEL="${WHISPER_MODEL:-models/ggml-small.en.bin}"

free_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true; }
wait_port() { for _ in $(seq 1 120); do lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }

echo "Freeing ports 2022 2023 5000 5002 5003 5005 8011 ..."
for p in 2022 2023 5000 5002 5003 5005 8011; do free_port "$p"; done
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

# Optional: Telugu voices live behind Piper (Kokoro has none). The UI is
# English-only by default, so skip this unless the piper venv and a Telugu model
# are both present. Set PIPER_TE_MODEL to a different voice to use another one.
if [ -x "$PIPER_PY" ] && [ -f "$PIPER_TE_MODEL" ]; then
  echo "[5003] piper-telugu (Telugu voices; Kokoro has none)"
  nohup "$PIPER_PY" -m piper.http_server -m "$PIPER_TE_MODEL" --data-dir "$PIPER_VOICES" \
    --host 127.0.0.1 --port 5003 >.logs/piper-telugu.log 2>&1 &
  wait_port 5003 && echo "      up" || echo "      FAILED (see .logs/piper-telugu.log) — Telugu voices unavailable"
else
  echo "[5003] piper-telugu: skipped (no piper venv or Telugu model; English/Kokoro unaffected)"
fi

echo "[5000] tts-proxy -> kokoro (en/hi/ja) + piper-telugu (te)"
KOKORO_BACKEND="http://127.0.0.1:5002/" PIPER_TE_BACKEND="http://127.0.0.1:5003/" PIPER_DEFAULT_VOICE="$KOKORO_VOICE" \
  nohup node examples/piper-http-server/server.mjs >.logs/tts-proxy.log 2>&1 &
wait_port 5000 && echo "      up" || { echo "      FAILED (see .logs/tts-proxy.log)"; exit 1; }

echo "[8011] static server"
nohup python3 -m http.server 8011 --bind 127.0.0.1 >.logs/static.log 2>&1 &
wait_port 8011 && echo "      up" || { echo "      FAILED (see .logs/static.log)"; exit 1; }

# Optional: outbound phone agent (Twilio ConversationRelay). Only starts when its
# .env is present, since it needs Twilio creds + a Groq key. Independent of the
# local voice stack; pair with `ngrok http 5005` to take real calls.
if [ -f "examples/phone-agent/.env" ]; then
  echo "[5005] phone-agent (Twilio ConversationRelay)"
  nohup node examples/phone-agent/server.mjs >.logs/phone-agent.log 2>&1 &
  wait_port 5005 && echo "      up" || echo "      FAILED (see .logs/phone-agent.log)"
else
  echo "[5005] phone-agent: skipped (no examples/phone-agent/.env; see examples/phone-agent/README.md)"
fi

echo
echo "All services up. Open:"
echo "  http://127.0.0.1:8011/examples/minimal-playground/index.html"
echo
echo "Stop everything with: ./stop-services.sh   (or kill the ports manually)"
