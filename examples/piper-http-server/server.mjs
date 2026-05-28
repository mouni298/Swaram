import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5000);
const piperBin = process.env.PIPER_BIN ?? "piper";
const voicesDir = process.env.PIPER_VOICES_DIR ?? path.join(__dirname, "voices");
const { piperVoicePresets } = await import("../../dist/voices.js");
const voices = Object.fromEntries(piperVoicePresets.map((voice) => [voice.id, voice.modelFile]));

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function resolveVoice(request) {
  const requestedVoice = request.headers["x-piper-voice"] ?? "en_US-lessac-medium";
  const voiceName = Array.isArray(requestedVoice) ? requestedVoice[0] : requestedVoice;
  const modelFile = voices[voiceName];

  if (!modelFile) {
    throw new Error(`Unknown Piper voice "${voiceName}".`);
  }

  const modelPath = path.join(voicesDir, modelFile);
  const configPath = `${modelPath}.json`;

  if (!existsSync(modelPath) || !existsSync(configPath)) {
    throw new Error(`Missing model files for "${voiceName}" in ${voicesDir}.`);
  }

  return { voiceName, modelPath };
}

function runPiper({ modelPath, text, outputPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(piperBin, ["--model", modelPath, "--output_file", outputPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `piper exited with code ${code}`));
      }
    });

    child.stdin.end(text);
  });
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

  let workDir;

  try {
    const text = (await readBody(request)).trim();
    if (!text) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Text body is required." }));
      return;
    }

    const { voiceName, modelPath } = resolveVoice(request);
    workDir = await mkdtemp(path.join(tmpdir(), "swaram-piper-"));
    const outputPath = path.join(workDir, "speech.wav");

    await runPiper({ modelPath, text, outputPath });
    const audio = await readFile(outputPath);

    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "X-Piper-Voice": voiceName,
    });
    response.end(audio);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    if (workDir) {
      await rm(workDir, { force: true, recursive: true });
    }
  }
});

server.listen(port, () => {
  console.log(`Piper HTTP server listening on http://localhost:${port}`);
  console.log(`Voice models directory: ${voicesDir}`);
});
