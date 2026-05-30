"""Warm Kokoro TTS server.

Loads the Kokoro ONNX model once and keeps it in memory, then serves synthesis
over HTTP. Speaks the SAME JSON contract as piper.http_server:

    POST /  {"text": "...", "voice": "af_heart"}  ->  WAV bytes

so the existing Node proxy (examples/piper-http-server/server.mjs) can forward to
it with no changes -- just point PIPER_BACKEND at this server.

Env:
    PORT            (default 5002)
    KOKORO_MODEL    path to kokoro-v1.0.onnx
    KOKORO_VOICES   path to voices-v1.0.bin
    KOKORO_VOICE    default voice when none/unknown is requested (default af_heart)
    KOKORO_SPEED    speech speed (default 1.0)
"""

import io
import json
import os
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from kokoro_onnx import Kokoro

PORT = int(os.environ.get("PORT", "5002"))
MODEL = os.environ["KOKORO_MODEL"]
VOICES = os.environ["KOKORO_VOICES"]
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))

print(f"Loading Kokoro model {MODEL} ...", flush=True)
kokoro = Kokoro(MODEL, VOICES)
KNOWN_VOICES = set(kokoro.get_voices())
print(f"Kokoro ready. {len(KNOWN_VOICES)} voices. Default: {DEFAULT_VOICE}", flush=True)


def to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quieter logs
        pass

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
            text = (data.get("text") or "").strip()
            if not text:
                self.send_error(400, "text is required")
                return

            requested = data.get("voice")
            voice = requested if requested in KNOWN_VOICES else DEFAULT_VOICE

            samples, sample_rate = kokoro.create(text, voice=voice, speed=SPEED, lang="en-us")
            audio = to_wav(np.asarray(samples), int(sample_rate))

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except Exception as error:  # noqa: BLE001 - surface to the proxy
            self.send_error(500, str(error))


if __name__ == "__main__":
    print(f"Kokoro HTTP server listening on http://127.0.0.1:{PORT}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
