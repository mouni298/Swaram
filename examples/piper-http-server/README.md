# Piper HTTP Server

This is a tiny local wrapper for the Piper CLI. It exposes the endpoint expected by the browser demos:

```txt
POST http://localhost:5000/api/tts
X-Piper-Voice: en_US-lessac-medium
Content-Type: text/plain
```

It maps `X-Piper-Voice` to a local `.onnx` model file, runs Piper, and returns `audio/wav`.

## 1. Install Piper

Install the Piper CLI so the `piper` command is available on your `PATH`.

```bash
pipx install piper-tts
```

If you do not use `pipx`, install it in your preferred Python environment.

## 2. Download Voice Models

Create the local voice folder:

```bash
mkdir -p examples/piper-http-server/voices
```

Download each `.onnx` file and its matching `.onnx.json` file:

```bash
curl -L -o examples/piper-http-server/voices/en_US-lessac-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -o examples/piper-http-server/voices/en_US-lessac-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

curl -L -o examples/piper-http-server/voices/en_US-amy-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx
curl -L -o examples/piper-http-server/voices/en_US-amy-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx.json

curl -L -o examples/piper-http-server/voices/en_US-ryan-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/medium/en_US-ryan-medium.onnx
curl -L -o examples/piper-http-server/voices/en_US-ryan-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json

curl -L -o examples/piper-http-server/voices/en_GB-alba-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alba/medium/en_GB-alba-medium.onnx
curl -L -o examples/piper-http-server/voices/en_GB-alba-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json

curl -L -o examples/piper-http-server/voices/en_GB-northern_english_male-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx
curl -L -o examples/piper-http-server/voices/en_GB-northern_english_male-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json

curl -L -o examples/piper-http-server/voices/hi_IN-priyamvada-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx
curl -L -o examples/piper-http-server/voices/hi_IN-priyamvada-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx.json

curl -L -o examples/piper-http-server/voices/hi_IN-pratham-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx
curl -L -o examples/piper-http-server/voices/hi_IN-pratham-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx.json

curl -L -o examples/piper-http-server/voices/te_IN-maya-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/maya/medium/te_IN-maya-medium.onnx
curl -L -o examples/piper-http-server/voices/te_IN-maya-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/maya/medium/te_IN-maya-medium.onnx.json

curl -L -o examples/piper-http-server/voices/te_IN-padmavathi-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/padmavathi/medium/te_IN-padmavathi-medium.onnx
curl -L -o examples/piper-http-server/voices/te_IN-padmavathi-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/padmavathi/medium/te_IN-padmavathi-medium.onnx.json

curl -L -o examples/piper-http-server/voices/te_IN-venkatesh-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/venkatesh/medium/te_IN-venkatesh-medium.onnx
curl -L -o examples/piper-http-server/voices/te_IN-venkatesh-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/venkatesh/medium/te_IN-venkatesh-medium.onnx.json
```

## 3. Start The Server

```bash
node examples/piper-http-server/server.mjs
```

The server listens on:

```txt
http://localhost:5000
```

## 4. Test One Voice

```bash
curl -o /tmp/swaram-test.wav \
  -H "Content-Type: text/plain" \
  -H "X-Piper-Voice: en_US-ryan-medium" \
  --data "Hello from Swaram AI." \
  http://localhost:5000/api/tts
```

If this creates `/tmp/swaram-test.wav`, the browser demo can use the same voice.

For Hindi and Telugu, test with text in the matching script:

```bash
curl -o /tmp/swaram-hindi.wav \
  -H "Content-Type: text/plain" \
  -H "X-Piper-Voice: hi_IN-priyamvada-medium" \
  --data "नमस्ते, मैं आपकी कैसे मदद कर सकती हूँ?" \
  http://localhost:5000/api/tts

curl -o /tmp/swaram-telugu.wav \
  -H "Content-Type: text/plain" \
  -H "X-Piper-Voice: te_IN-maya-medium" \
  --data "నమస్తే, నేను మీకు ఎలా సహాయం చేయగలను?" \
  http://localhost:5000/api/tts
```

## Language Notes

Language works across three different parts of the stack:

- Whisper.cpp receives the selected language for transcription.
- The demo adds a language instruction so Ollama answers in English, Hindi, or Telugu.
- Piper receives the selected voice name through `X-Piper-Voice`.

For best results, the LLM response script must match the Piper voice. Hindi voices expect Devanagari text, and Telugu voices expect Telugu script.

## Configuration

Use these environment variables if needed:

```bash
PORT=5000 PIPER_BIN=/path/to/piper PIPER_VOICES_DIR=/path/to/voices node examples/piper-http-server/server.mjs
```
