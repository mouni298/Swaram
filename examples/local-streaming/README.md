# Local Streaming Demo

This demo uses only local/open-source services.

Expected services:

- `whisper.cpp` server at `http://localhost:2022`
- Ollama at `http://localhost:11434`
- Piper HTTP server at `http://localhost:5000`

The demo exposes these Piper voice choices:

- `en_US-lessac-medium`
- `en_US-amy-medium`
- `en_US-ryan-medium`
- `en_GB-alba-medium`
- `en_GB-northern_english_male-medium`
- `hi_IN-priyamvada-medium`
- `hi_IN-pratham-medium`
- `te_IN-maya-medium`
- `te_IN-padmavathi-medium`
- `te_IN-venkatesh-medium`

The selected language is sent to Whisper.cpp for transcription. The selected voice is sent to the Piper server as the `X-Piper-Voice` header. Your Piper HTTP wrapper must have the matching `.onnx` and `.onnx.json` voice models installed and must route that header to the right model.

Hindi and Telugu also require the LLM to respond in the matching script. The demo appends a language instruction so Ollama uses Devanagari for Hindi and Telugu script for Telugu.

Build the SDK:

```bash
npm run build
```

Serve the repo root:

```bash
npx http-server . -p 4173
```

Open:

```txt
http://127.0.0.1:4173/examples/local-streaming/index.html
```

The Whisper and Piper HTTP endpoints vary by wrapper. If your local server uses different paths, edit `main.js` and pass `endpoint` to `WhisperCppSTTProvider` or `PiperTTSProvider`.
