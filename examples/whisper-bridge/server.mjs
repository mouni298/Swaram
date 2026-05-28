import { createServer } from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT ?? 2022);
const whisperUrl = process.env.WHISPER_URL ?? "http://127.0.0.1:2023/inference";
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function extractFilePart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerEnd = Buffer.from("\r\n\r\n");
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) {
      break;
    }

    const partStart = start + delimiter.length;
    const next = body.indexOf(delimiter, partStart);
    if (next === -1) {
      break;
    }

    const part = body.subarray(partStart, next);
    const headerSplit = part.indexOf(headerEnd);
    if (headerSplit === -1) {
      cursor = next;
      continue;
    }

    const headers = part.subarray(0, headerSplit).toString("utf8");
    if (/name="file"/i.test(headers)) {
      // Content is between the header block and the trailing CRLF before the next delimiter.
      return part.subarray(headerSplit + headerEnd.length, part.length - 2);
    }

    cursor = next;
  }

  return null;
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
    const boundaryMatch = /boundary=(.+)$/.exec(contentType);
    if (!boundaryMatch) {
      throw new Error("Expected multipart/form-data with a boundary.");
    }

    const body = await readBody(request);
    const filePart = extractFilePart(body, boundaryMatch[1].replace(/^"|"$/g, ""));
    if (!filePart || filePart.length === 0) {
      throw new Error("No audio file part found in request.");
    }

    const wav = await transcodeToWav(filePart);

    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");

    const whisperResponse = await fetch(whisperUrl, { method: "POST", body: form });
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
