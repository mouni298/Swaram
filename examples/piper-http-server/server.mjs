import { createServer } from "node:http";

// Thin CORS-enabled proxy in front of the official `piper.http_server`, which
// keeps the voice model loaded in memory (~0.15s/request vs ~1.5s when the piper
// CLI is cold-spawned per request). The browser PiperTTSProvider posts
// text/plain to /api/tts with an X-Piper-Voice header; we translate that to the
// backend's JSON API and stream the WAV back.
const port = Number(process.env.PORT ?? 5000);
const backend = process.env.PIPER_BACKEND ?? "http://127.0.0.1:5001/";
const defaultVoice = process.env.PIPER_DEFAULT_VOICE ?? "en_US-lessac-medium";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

// A minimal valid mono 16-bit WAV of silence. Returned for chunks the backend
// can't voice (punctuation-only fragments make piper emit zero frames, which
// crashes its incremental WAV writer). Decodes cleanly in the browser so the
// turn keeps playing instead of erroring out.
function silentWav(sampleRate = 22050, ms = 20) {
  const numSamples = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// Whether the text has anything piper can actually voice.
function hasSpeakableContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Piper-Voice");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST" || request.url !== "/api/tts") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Use POST /api/tts" }));
    return;
  }

  try {
    const text = (await readBody(request)).trim();
    if (!text) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Text body is required." }));
      return;
    }

    const requested = request.headers["x-piper-voice"];
    const voice = (Array.isArray(requested) ? requested[0] : requested) ?? defaultVoice;

    // Punctuation/symbol-only chunks make piper emit zero frames -> backend 500.
    // Return silence so the turn isn't aborted by an unspeakable fragment.
    if (!hasSpeakableContent(text)) {
      response.writeHead(200, { "Content-Type": "audio/wav", "X-Piper-Voice": voice });
      response.end(silentWav());
      return;
    }

    const backendResponse = await fetch(backend, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });

    if (!backendResponse.ok) {
      const detail = await backendResponse.text().catch(() => "");
      // Don't let a single failed chunk kill the whole turn (the agent treats a
      // TTS error as fatal). Log it and return silence so playback continues.
      console.error(`piper backend ${backendResponse.status} for ${JSON.stringify(text)}: ${detail.trim()}`);
      response.writeHead(200, { "Content-Type": "audio/wav", "X-Piper-Voice": voice });
      response.end(silentWav());
      return;
    }

    const audio = Buffer.from(await backendResponse.arrayBuffer());
    response.writeHead(200, { "Content-Type": "audio/wav", "X-Piper-Voice": voice });
    response.end(audio);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, () => {
  console.log(`Piper proxy listening on http://localhost:${port}/api/tts -> ${backend}`);
});
