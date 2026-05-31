import { createServer } from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT ?? 2022);
const whisperBase = process.env.WHISPER_BASE ?? "http://127.0.0.1:2023";
const whisperUrl = `${whisperBase}/inference`;
const whisperLoadUrl = `${whisperBase}/load`;
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const debug = process.env.DEBUG === "1";

// Model aliases the playground can request -> ggml paths (relative to the
// whisper-server CWD, vendor/whisper.cpp). whisper-server's /load endpoint
// hot-swaps the loaded model, so one server serves every model on demand.
const MODELS = {
  "small.en": "models/ggml-small.en.bin",
  small: "models/ggml-small.bin",
  medium: "models/ggml-medium.bin",
  "large-v3": "models/ggml-large-v3.bin",
};
const DEFAULT_MODEL = process.env.WHISPER_DEFAULT_MODEL ?? "small.en";
let loadedModel = DEFAULT_MODEL;

async function ensureModelLoaded(alias) {
  const wanted = MODELS[alias] ? alias : DEFAULT_MODEL;
  if (wanted === loadedModel) {
    return;
  }
  const form = new FormData();
  form.append("model", MODELS[wanted]);
  const res = await fetch(whisperLoadUrl, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`whisper.cpp /load (${wanted}) failed with status ${res.status}.`);
  }
  loadedModel = wanted;
  if (debug) {
    console.log(`[debug] swapped whisper model -> ${wanted} (${MODELS[wanted]})`);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function transcodeToWav(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ["-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });

    child.stdin.end(input);
  });
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST" || !request.url?.startsWith("/v1/audio/transcriptions")) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Use POST /v1/audio/transcriptions" }));
    return;
  }

  try {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new Error("Expected multipart/form-data.");
    }

    // Let undici parse multipart properly instead of hand-rolling a boundary scan,
    // which broke when boundary-like bytes appeared inside the Opus payload.
    const body = await readBody(request);
    const form = await new Request("http://bridge/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();

    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new Error("No audio file part found in request.");
    }

    const webm = Buffer.from(await file.arrayBuffer());
    if (webm.length === 0) {
      throw new Error("Audio file part was empty.");
    }

    const model = typeof form.get("model") === "string" ? form.get("model") : DEFAULT_MODEL;
    const language = typeof form.get("language") === "string" ? form.get("language") : "";

    if (debug) {
      console.log(`[debug] webm=${webm.length}B model=${model} language=${language || "auto"}`);
    }

    // Hot-swap the whisper model if the requested one differs from what's loaded.
    await ensureModelLoaded(model);

    const wav = await transcodeToWav(webm);

    const whisperForm = new FormData();
    whisperForm.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    whisperForm.append("response_format", "json");
    // Tell whisper which language to decode (critical for hi/ja/te; "" = autodetect).
    // whisper wants a 2-letter code, but the UI sends e.g. "hi-IN" / "te-IN".
    const whisperLang = language ? language.slice(0, 2).toLowerCase() : "";
    if (whisperLang) {
      whisperForm.append("language", whisperLang);
    }

    const whisperResponse = await fetch(whisperUrl, { method: "POST", body: whisperForm });
    if (!whisperResponse.ok) {
      throw new Error(`whisper.cpp /inference failed with status ${whisperResponse.status}.`);
    }

    const result = await whisperResponse.json();
    const text = (result.text ?? result.transcription ?? "").trim();

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ text }));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Whisper bridge listening on http://127.0.0.1:${port}/v1/audio/transcriptions`);
  console.log(`Transcoding webm -> wav and forwarding to ${whisperUrl}`);
});
