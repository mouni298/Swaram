import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import dotenv from "dotenv";
import twilio from "twilio";
import { WebSocketServer } from "ws";

import {
  TextVoiceAgent,
  GroqStreamingLLMProvider,
  ecommerceSupportTemplate,
  parseRelayMessage,
  textMessage,
  endSession,
  buildConversationRelayTwiML,
} from "../../dist/index.js";

// ---------------------------------------------------------------------------
// Outbound phone agent over Twilio ConversationRelay.
//
// Twilio does STT + TTS + barge-in; this server runs only the LLM + tools +
// transcript via the SDK's TextVoiceAgent and exchanges text over a WebSocket.
//
//   browser panel ──POST /call──▶ here ──twilio.calls.create──▶ Twilio dials out
//   Twilio ──GET /voice (TwiML)──▶ here ; Twilio ──WS /relay──⇄ TextVoiceAgent
//   Twilio ──POST /status──▶ here ; browser ◀──SSE /events── here
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, ".env") });

const PORT = Number(process.env.PORT ?? 5005);
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  GROQ_API_KEY,
  GROQ_MODEL = "llama-3.1-8b-instant",
  CALL_SECRET = "",
  CR_VOICE = "",
} = process.env;
const MAX_CALL_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);
const VALIDATE_SIGNATURE = process.env.VALIDATE_TWILIO_SIGNATURE === "1";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// Per-call config (set at /call, read at /voice + WS setup), keyed by a cfgId the
// browser also holds so it can open the matching SSE stream.
const configs = new Map(); // cfgId -> { to, greeting, instructions, model, voice, callSid? }
const sseClients = new Map(); // cfgId -> Set<ServerResponse>
const sessions = new Map(); // callSid -> { cfgId, agent, ws, timer }
const callSidToCfg = new Map(); // callSid -> cfgId

// ---------------------------------------------------------------------------
// Public URL (Twilio must reach us): explicit PUBLIC_URL, else the running ngrok
// tunnel, discovered from ngrok's local API.
// ---------------------------------------------------------------------------
let cachedPublicUrl = process.env.PUBLIC_URL ?? "";

async function getPublicUrl() {
  if (cachedPublicUrl) {
    return cachedPublicUrl.replace(/\/$/, "");
  }
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    const data = await res.json();
    const https = (data.tunnels ?? []).find((t) => t.public_url?.startsWith("https://"));
    if (https) {
      cachedPublicUrl = https.public_url;
      console.log(`[phone-agent] auto-detected ngrok URL: ${cachedPublicUrl}`);
      return cachedPublicUrl;
    }
  } catch {
    /* ngrok not running */
  }
  throw new Error("No PUBLIC_URL set and no ngrok tunnel found. Start `ngrok http " + PORT + "` or set PUBLIC_URL.");
}

const toWss = (httpsUrl) => httpsUrl.replace(/^https/, "wss");

// ---------------------------------------------------------------------------
// SSE: push call status + transcript to the browser panel.
// ---------------------------------------------------------------------------
function sse(cfgId, event, data) {
  const clients = sseClients.get(cfgId);
  if (!clients) {
    return;
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function validateTwilioSignature(req, url, params) {
  if (!VALIDATE_SIGNATURE || !TWILIO_AUTH_TOKEN) {
    return true;
  }
  const signature = req.headers["x-twilio-signature"];
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature ?? "", url, params ?? {});
}

// ---------------------------------------------------------------------------
// POST /call — trigger an outbound call (from the browser panel).
// ---------------------------------------------------------------------------
async function handleCall(req, res) {
  if (!twilioClient || !TWILIO_NUMBER || !GROQ_API_KEY) {
    return json(res, 500, {
      error: "Server not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, GROQ_API_KEY in .env.",
    });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Invalid JSON body." });
  }

  if (CALL_SECRET && body.secret !== CALL_SECRET) {
    return json(res, 401, { error: "Bad or missing call secret." });
  }
  const to = String(body.to ?? "").trim();
  if (!/^\+\d{6,15}$/.test(to)) {
    return json(res, 400, { error: "`to` must be E.164, e.g. +14155551234." });
  }

  const cfgId = randomUUID();
  configs.set(cfgId, {
    to,
    greeting: String(body.greeting ?? "Hello, this is an automated assistant calling. How can I help?"),
    instructions: String(body.instructions ?? ecommerceSupportTemplate.instructions),
    model: String(body.model ?? GROQ_MODEL),
    voice: String(body.voice ?? CR_VOICE),
  });

  let publicUrl;
  try {
    publicUrl = await getPublicUrl();
  } catch (error) {
    configs.delete(cfgId);
    return json(res, 500, { error: error.message });
  }

  try {
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: `${publicUrl}/voice?cfgId=${cfgId}`,
      statusCallback: `${publicUrl}/status?cfgId=${cfgId}`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    configs.get(cfgId).callSid = call.sid;
    callSidToCfg.set(call.sid, cfgId);
    sse(cfgId, "status", { status: "queued", callSid: call.sid });
    return json(res, 200, { cfgId, callSid: call.sid });
  } catch (error) {
    configs.delete(cfgId);
    return json(res, 502, { error: `Twilio call failed: ${error.message}` });
  }
}

// ---------------------------------------------------------------------------
// GET /voice — Twilio fetches the TwiML that starts ConversationRelay.
// ---------------------------------------------------------------------------
async function handleVoice(req, res, url) {
  const cfgId = url.searchParams.get("cfgId");
  const cfg = cfgId && configs.get(cfgId);
  if (!cfg) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Unknown cfgId");
  }

  let publicUrl;
  try {
    publicUrl = await getPublicUrl();
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end(error.message);
  }

  const fullUrl = `${publicUrl}/voice?cfgId=${cfgId}`;
  if (!validateTwilioSignature(req, fullUrl, {})) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Invalid Twilio signature");
  }

  const twiml = buildConversationRelayTwiML({
    wsUrl: `${toWss(publicUrl)}/relay`,
    welcomeGreeting: cfg.greeting,
    ...(cfg.voice ? { voice: cfg.voice } : {}),
    parameters: { cfgId },
  });
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml);
}

// ---------------------------------------------------------------------------
// POST /status — Twilio call lifecycle callbacks.
// ---------------------------------------------------------------------------
async function handleStatus(req, res, url) {
  const cfgId = url.searchParams.get("cfgId");
  const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
  const status = params.CallStatus ?? "unknown";
  if (cfgId) {
    sse(cfgId, "status", { status, callSid: params.CallSid });
    if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
      // Give the SSE a moment to flush, then drop the config.
      setTimeout(() => configs.delete(cfgId), 5000);
    }
  }
  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------
// GET /events — SSE stream to the browser panel for a given cfgId.
// ---------------------------------------------------------------------------
function handleEvents(req, res, url) {
  const cfgId = url.searchParams.get("cfgId");
  if (!cfgId) {
    return json(res, 400, { error: "cfgId required" });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`event: open\ndata: {}\n\n`);
  const set = sseClients.get(cfgId) ?? new Set();
  set.add(res);
  sseClients.set(cfgId, set);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) {
      sseClients.delete(cfgId);
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket /relay — bridge ConversationRelay <-> TextVoiceAgent for one call.
// ---------------------------------------------------------------------------
function attachRelay(wss) {
  wss.on("connection", (ws) => {
    let session = null;

    const cleanup = () => {
      if (!session) {
        return;
      }
      clearTimeout(session.timer);
      session.agent.interrupt();
      sessions.delete(session.callSid);
      session = null;
    };

    ws.on("message", async (raw) => {
      const msg = parseRelayMessage(raw);

      if (msg.type === "setup") {
        const cfgId = msg.customParameters?.cfgId;
        let cfg = cfgId && configs.get(cfgId);
        // No-phone simulator hook: only when ALLOW_SIM=1, build a config from
        // params the client supplies (Twilio never sends these). Lets
        // simulate-relay.mjs exercise the Groq<->relay bridge with no call.
        if (!cfg && process.env.ALLOW_SIM === "1" && msg.customParameters?.simInstructions) {
          cfg = {
            instructions: msg.customParameters.simInstructions,
            model: msg.customParameters.simModel || GROQ_MODEL,
            voice: "",
            greeting: "",
          };
        }
        if (!cfg) {
          ws.send(JSON.stringify(endSession({ reason: "unknown-config" })));
          return;
        }

        const agent = new TextVoiceAgent({
          instructions: cfg.instructions,
          tools: ecommerceSupportTemplate.tools,
          llm: new GroqStreamingLLMProvider({ apiKey: GROQ_API_KEY, model: cfg.model }),
        });

        // Stream every human-facing token to Twilio TTS.
        agent.on("token", ({ text }) => ws.send(JSON.stringify(textMessage(text, false))));
        agent.on("transcript", ({ message }) => {
          if (message.role !== "system") {
            sse(cfgId, "transcript", { role: message.role, content: message.content });
          }
        });
        agent.on("toolCall", ({ toolCall }) => sse(cfgId, "toolCall", { name: toolCall.name, result: toolCall.result }));
        agent.on("error", ({ error }) => sse(cfgId, "error", { message: error.message }));

        const timer = setTimeout(() => {
          ws.send(JSON.stringify(endSession({ reason: "max-duration" })));
          sse(cfgId, "status", { status: "ended", reason: "max-duration" });
        }, MAX_CALL_SECONDS * 1000);

        session = { cfgId, callSid: msg.callSid, agent, ws, timer };
        sessions.set(msg.callSid, session);
        callSidToCfg.set(msg.callSid, cfgId);
        sse(cfgId, "status", { status: "connected", callSid: msg.callSid });
        return;
      }

      if (!session) {
        return;
      }

      if (msg.type === "prompt" && msg.last && msg.text.trim()) {
        try {
          await session.agent.handlePrompt(msg.text);
          // Mark the end of this agent turn so Twilio knows to stop synthesizing.
          ws.send(JSON.stringify(textMessage("", true)));
        } catch (error) {
          ws.send(JSON.stringify(textMessage("Sorry, I'm having trouble right now. Goodbye.", true)));
          ws.send(JSON.stringify(endSession({ reason: "agent-error", message: error.message })));
        }
        return;
      }

      if (msg.type === "interrupt") {
        session.agent.interrupt();
        return;
      }

      if (msg.type === "error") {
        sse(session.cfgId, "error", { message: msg.errorMessage ?? `Twilio error ${msg.errorCode}` });
      }
    });

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}

// ---------------------------------------------------------------------------
// Wire it all together.
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/call") {
      return await handleCall(req, res);
    }
    if (req.method === "GET" && url.pathname === "/voice") {
      return await handleVoice(req, res, url);
    }
    if (req.method === "POST" && url.pathname === "/status") {
      return await handleStatus(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      return handleEvents(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, configured: Boolean(twilioClient && TWILIO_NUMBER && GROQ_API_KEY) });
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ server, path: "/relay" });
attachRelay(wss);

server.listen(PORT, () => {
  console.log(`[phone-agent] http + ws on http://127.0.0.1:${PORT}`);
  console.log(`[phone-agent] configured: ${Boolean(twilioClient && TWILIO_NUMBER && GROQ_API_KEY)}`);
  if (process.env.PUBLIC_URL) {
    console.log(`[phone-agent] PUBLIC_URL = ${process.env.PUBLIC_URL}`);
  } else {
    console.log(`[phone-agent] PUBLIC_URL not set — will auto-detect ngrok on first call`);
  }
});
