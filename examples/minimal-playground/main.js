import {
  BrowserVADProvider,
  GroqStreamingLLMProvider,
  PiperTTSProvider,
  StreamingVoiceSupportAgent,
  WhisperCppSTTProvider,
  ecommerceSupportTemplate,
  voicePresets,
} from "../../dist/index.js";
import {
  loadRnnoise,
  RnnoiseWorkletNode,
} from "/node_modules/@sapphi-red/web-noise-suppressor/dist/index.js";

const NOISE_SUPPRESSOR_BASE = "/node_modules/@sapphi-red/web-noise-suppressor/dist";

// Builds a single shared mic pipeline:  mic -> RNNoise denoiser -> clean stream.
// The denoised stream feeds the VAD (and, in "vad" STT mode, Whisper too), so it
// both improves transcription and stops background noise / echo from triggering
// false barge-ins. RNNoise runs at 48kHz, so we pin the AudioContext to 48000.
let denoisePipeline = null;

async function buildDenoisedStream() {
  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const context = new AudioContext({ sampleRate: 48000 });
  const source = context.createMediaStreamSource(rawStream);

  const wasmBinary = await loadRnnoise({
    url: `${NOISE_SUPPRESSOR_BASE}/rnnoise.wasm`,
    simdUrl: `${NOISE_SUPPRESSOR_BASE}/rnnoise_simd.wasm`,
  });
  await context.audioWorklet.addModule(`${NOISE_SUPPRESSOR_BASE}/rnnoise/workletProcessor.js`);
  const rnnoise = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });

  const destination = context.createMediaStreamDestination();
  source.connect(rnnoise).connect(destination);

  denoisePipeline = { rawStream, context, rnnoise, destination };
  return destination.stream;
}

function teardownDenoisedStream() {
  if (!denoisePipeline) {
    return;
  }
  const { rawStream, context, rnnoise, destination } = denoisePipeline;
  denoisePipeline = null;
  try {
    rnnoise.disconnect();
  } catch {
    /* ignore */
  }
  destination.stream.getTracks().forEach((track) => track.stop());
  rawStream.getTracks().forEach((track) => track.stop());
  void context.close();
}

const instructions = document.querySelector("#instructions");
const language = document.querySelector("#language");
const transcript = document.querySelector("#transcript");
const statusPill = document.querySelector("#agent-status");
const statusText = document.querySelector("#agent-status-text");
const statusCopy = document.querySelector("#status-copy");
const voiceArea = document.querySelector("#voice-area");
const talk = document.querySelector("#talk");
const talkLabel = document.querySelector("#talk-label");
const reset = document.querySelector("#reset");
const tts = document.querySelector("#tts");
const llm = document.querySelector("#llm");
const groqKeyInput = document.querySelector("#groq-key");
const voiceOrb = document.querySelector(".voice-orb");
const ctxVoice = document.querySelector("#ctx-voice");
const ctxModel = document.querySelector("#ctx-model");

// Sidebar tabs: toggle which settings group is visible.
const tabs = [...document.querySelectorAll(".tab")];
const panels = [...document.querySelectorAll(".tab-panel")];
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    for (const t of tabs) {
      t.classList.toggle("active", t === tab);
    }
    for (const p of panels) {
      p.classList.toggle("active", p.dataset.panel === target);
    }
  });
}

// Tracks whether the user has an explicit live mic session running (Talk pressed
// and not yet stopped). Drives the Talk/Stop button; separate from per-turn
// status, which also moves for typed turns.
let voiceSessionOn = false;

const ACTIVE_STATUSES = ["listening", "user_speaking", "transcribing", "thinking", "speaking"];

function updateTalkButton() {
  if (voiceSessionOn) {
    talkLabel.textContent = "Stop session";
    talk.classList.add("stop");
  } else {
    talkLabel.textContent = "Talk to your agent";
    talk.classList.remove("stop");
  }
}

function updateContext() {
  ctxVoice.textContent = selectedVoiceLabel().split(" — ")[0] ?? selectedVoiceLabel();
  ctxModel.textContent = (llm.options[llm.selectedIndex]?.text ?? llm.value).replace(/^Groq · /, "");
}

const GROQ_KEY_STORAGE = "swaram.groq.apiKey";
const GROQ_MODEL_STORAGE = "swaram.groq.model";

const storedKey = localStorage.getItem(GROQ_KEY_STORAGE) ?? "";
const storedModel = localStorage.getItem(GROQ_MODEL_STORAGE);
groqKeyInput.value = storedKey;
if (storedModel) {
  llm.value = storedModel;
}

groqKeyInput.addEventListener("input", () => {
  localStorage.setItem(GROQ_KEY_STORAGE, groqKeyInput.value.trim());
});

const sttModelSelect = document.querySelector("#transcription");

instructions.value = ecommerceSupportTemplate.instructions;

// Supported languages, the LLM "respond in X" instruction, and the voices for
// each. en/hi/ja use Kokoro voices; Telugu uses Piper voices (te_*), which the
// TTS proxy routes to the Piper backend. The whisper language code is the first
// two letters of the id (set by the bridge).
// English only for now. Hindi/Telugu were dropped because the local models
// (whisper STT, Kokoro/Piper TTS) aren't accurate enough for Indian languages;
// revisit with purpose-built models (AI4Bharat/Sarvam) when needed.
const LANGUAGES = [
  {
    id: "en-US",
    label: "English (US)",
    instruction: "Respond in English.",
    voices: [
      { id: "af_heart", label: "Heart — US female" },
      { id: "af_bella", label: "Bella — US female" },
      { id: "af_nicole", label: "Nicole — US female (soft)" },
      { id: "af_sky", label: "Sky — US female" },
      { id: "am_michael", label: "Michael — US male" },
      { id: "am_adam", label: "Adam — US male" },
      { id: "am_puck", label: "Puck — US male" },
      { id: "bf_emma", label: "Emma — UK female" },
      { id: "bf_isabella", label: "Isabella — UK female" },
      { id: "bm_george", label: "George — UK male" },
      { id: "bm_lewis", label: "Lewis — UK male" },
    ],
  },
];

// whisper.cpp models the bridge can hot-swap to (small.en is the English default).
const STT_MODELS = [
  { id: "small.en", label: "small.en — fast (default)" },
  { id: "small", label: "small — multilingual" },
  { id: "medium", label: "medium — more accurate" },
  { id: "large-v3", label: "large-v3 — best (slow)" },
];

function currentLanguage() {
  return LANGUAGES.find((entry) => entry.id === language.value) ?? LANGUAGES[0];
}

function langInstruction(id) {
  return (LANGUAGES.find((entry) => entry.id === id) ?? LANGUAGES[0]).instruction;
}

function effectiveSttModel() {
  return sttModelSelect.value;
}

function populateVoicesForLanguage() {
  tts.replaceChildren(
    ...currentLanguage().voices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.label;
      return option;
    }),
  );
}

function selectedVoiceLabel() {
  return tts.options[tts.selectedIndex]?.text ?? tts.value;
}

language.replaceChildren(
  ...LANGUAGES.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.label;
    return option;
  }),
);

sttModelSelect.replaceChildren(
  ...STT_MODELS.map((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    return option;
  }),
);

populateVoicesForLanguage();

// ---------------------------------------------------------------------------
// Custom tools: a user-defined toolbox the agent can call. Persisted locally.
// Each tool advertises a JSON-Schema to the model (native function calling); on
// call it either returns a fixed mock result or POSTs the args to a webhook.
// ---------------------------------------------------------------------------
const TOOLS_STORAGE = "swaram.customTools";
const DEMO_TOOLS_STORAGE = "swaram.useDemoTools";
const RESERVED_NAMES = new Set(ecommerceSupportTemplate.tools.map((tool) => tool.name));

const DEFAULT_PARAMS = `{
  "type": "object",
  "properties": {
    "city": { "type": "string", "description": "City name" }
  },
  "required": ["city"]
}`;
const DEFAULT_RESULT = `{ "temperature": "72F", "conditions": "sunny" }`;

function loadCustomTools() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TOOLS_STORAGE) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let customTools = loadCustomTools();
let useDemoTools = localStorage.getItem(DEMO_TOOLS_STORAGE) !== "false";

function saveCustomTools() {
  localStorage.setItem(TOOLS_STORAGE, JSON.stringify(customTools));
}

// Turn a stored tool spec into a ToolDefinition.run implementation.
function makeRunner(tool) {
  if (tool.mode === "webhook") {
    return async (args) => {
      try {
        const res = await fetch(tool.response, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args ?? {}),
        });
        if (!res.ok) {
          return { error: `Webhook returned ${res.status}` };
        }
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    };
  }

  // Static mock: parse once, return the same value on every call.
  let value;
  try {
    value = JSON.parse(tool.response);
  } catch {
    value = tool.response;
  }
  return () => value;
}

function buildToolDefinitions() {
  const custom = customTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    run: makeRunner(tool),
  }));
  return useDemoTools ? [...ecommerceSupportTemplate.tools, ...custom] : custom;
}

// ---- Tool list UI ----
const toolListEl = document.querySelector("#tool-list");
const demoToolsToggle = document.querySelector("#demo-tools-toggle");
demoToolsToggle.checked = useDemoTools;

function renderToolList() {
  toolListEl.replaceChildren();
  if (customTools.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tool-empty";
    empty.textContent = "No custom tools yet. Add one to extend the agent.";
    toolListEl.append(empty);
    return;
  }

  for (const tool of customTools) {
    const item = document.createElement("div");
    item.className = "tool-item";

    const meta = document.createElement("div");
    meta.className = "tool-meta";
    const name = document.createElement("div");
    name.className = "tool-name";
    const badge = document.createElement("span");
    badge.className = "tool-badge";
    badge.textContent = tool.mode === "webhook" ? "webhook" : "mock";
    name.append(document.createTextNode(tool.name), badge);
    const desc = document.createElement("div");
    desc.className = "tool-desc";
    desc.textContent = tool.description;
    meta.append(name, desc);

    const ops = document.createElement("div");
    ops.className = "tool-ops";
    const edit = document.createElement("button");
    edit.className = "icon-btn";
    edit.title = "Edit";
    edit.textContent = "✎";
    edit.addEventListener("click", () => openToolEditor(tool));
    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.title = "Delete";
    del.textContent = "🗑";
    del.addEventListener("click", () => deleteTool(tool.id));
    ops.append(edit, del);

    item.append(meta, ops);
    toolListEl.append(item);
  }
}

function deleteTool(id) {
  customTools = customTools.filter((tool) => tool.id !== id);
  saveCustomTools();
  renderToolList();
  recreateAgent({ ready: "Tool removed." });
}

// ---- Tool editor dialog ----
const toolDialog = document.querySelector("#tool-editor");
const toolForm = document.querySelector("#tool-form");
const fTitle = document.querySelector("#tool-dialog-title");
const fName = document.querySelector("#tool-name");
const fDesc = document.querySelector("#tool-desc");
const fParams = document.querySelector("#tool-params");
const fMode = document.querySelector("#tool-mode");
const fResult = document.querySelector("#tool-result");
const fUrl = document.querySelector("#tool-url");
const staticRow = document.querySelector("#tool-static-row");
const webhookRow = document.querySelector("#tool-webhook-row");
const fError = document.querySelector("#tool-error");
let editingId = null;

function syncModeRows() {
  const webhook = fMode.value === "webhook";
  webhookRow.hidden = !webhook;
  staticRow.hidden = webhook;
}

function openToolEditor(tool) {
  editingId = tool?.id ?? null;
  fTitle.textContent = tool ? "Edit tool" : "Add tool";
  fName.value = tool?.name ?? "";
  fDesc.value = tool?.description ?? "";
  fParams.value = JSON.stringify(tool?.parameters ?? JSON.parse(DEFAULT_PARAMS), null, 2);
  fMode.value = tool?.mode ?? "static";
  fResult.value = tool && tool.mode === "static" ? tool.response : DEFAULT_RESULT;
  fUrl.value = tool && tool.mode === "webhook" ? tool.response : "";
  fError.hidden = true;
  syncModeRows();
  toolDialog.showModal();
}

function fail(message) {
  fError.textContent = message;
  fError.hidden = false;
  return null;
}

// Validate the form and return a tool spec, or null (with an error shown).
function readToolForm() {
  const name = fName.value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    return fail("Name must start with a letter and use only letters, numbers, or underscores.");
  }
  if (RESERVED_NAMES.has(name)) {
    return fail(`"${name}" is reserved by a demo tool. Pick another name.`);
  }
  if (customTools.some((tool) => tool.name === name && tool.id !== editingId)) {
    return fail(`A tool named "${name}" already exists.`);
  }

  const description = fDesc.value.trim();
  if (!description) {
    return fail("Description is required — it's how the model knows when to call the tool.");
  }

  let parameters;
  try {
    parameters = JSON.parse(fParams.value);
  } catch (error) {
    return fail(`Parameters must be valid JSON. ${error.message}`);
  }
  if (!parameters || parameters.type !== "object") {
    return fail('Parameters must be a JSON Schema object, e.g. { "type": "object", "properties": {} }.');
  }

  const mode = fMode.value;
  let response;
  if (mode === "webhook") {
    response = fUrl.value.trim();
    try {
      void new URL(response);
    } catch {
      return fail("Enter a valid webhook URL (https://…).");
    }
  } else {
    response = fResult.value.trim();
    try {
      JSON.parse(response);
    } catch (error) {
      return fail(`Result must be valid JSON. ${error.message}`);
    }
  }

  return { id: editingId ?? `tool_${Date.now()}`, name, description, parameters, mode, response };
}

toolForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const spec = readToolForm();
  if (!spec) {
    return;
  }
  const index = customTools.findIndex((tool) => tool.id === spec.id);
  if (index >= 0) {
    customTools[index] = spec;
  } else {
    customTools.push(spec);
  }
  saveCustomTools();
  renderToolList();
  toolDialog.close();
  recreateAgent({ ready: `Tool "${spec.name}" saved.` });
});

document.querySelector("#tool-add").addEventListener("click", () => openToolEditor(null));
document.querySelector("#tool-cancel").addEventListener("click", () => toolDialog.close());
fMode.addEventListener("change", syncModeRows);

demoToolsToggle.addEventListener("change", () => {
  useDemoTools = demoToolsToggle.checked;
  localStorage.setItem(DEMO_TOOLS_STORAGE, String(useDemoTools));
  recreateAgent({ ready: useDemoTools ? "Demo tools enabled." : "Demo tools disabled." });
});

renderToolList();

let agent = createAgent();
let lastUsedKey = (groqKeyInput.value || localStorage.getItem(GROQ_KEY_STORAGE) || "").trim();
let micLevelMeter = null;

function setVoiceLevel(level) {
  voiceOrb?.style.setProperty("--voice-level", level.toFixed(3));
}

async function startMicLevelMeter() {
  if (micLevelMeter || !navigator.mediaDevices?.getUserMedia) {
    return;
  }

  statusPill.textContent = "Microphone";
  statusCopy.textContent = "Waiting for microphone access.";
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextConstructor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  let animationFrame = 0;
  let smoothedLevel = 0;

  analyser.fftSize = 1024;
  const samples = new Uint8Array(analyser.fftSize);
  source.connect(analyser);

  const tick = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;

    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }

    const rms = Math.sqrt(sum / samples.length);
    const nextLevel = Math.min(1, Math.max(0, (rms - 0.015) * 8));
    smoothedLevel = smoothedLevel * 0.75 + nextLevel * 0.25;
    setVoiceLevel(smoothedLevel);
    animationFrame = requestAnimationFrame(tick);
  };

  tick();

  micLevelMeter = {
    stop() {
      cancelAnimationFrame(animationFrame);
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      setVoiceLevel(0);
      micLevelMeter = null;
    },
  };
}

function stopMicLevelMeter() {
  micLevelMeter?.stop();
}

function createVADProvider() {
  return new BrowserVADProvider({
    loadModule: () => Promise.resolve(window.vad),
    baseAssetPath: "/node_modules/@ricky0123/vad-web/dist/",
    onnxWASMBasePath: "/node_modules/onnxruntime-web/dist/",
    // Feed the VAD an RNNoise-denoised mic stream (also requests the browser's
    // built-in echo cancellation / noise suppression on the raw mic).
    getStream: buildDenoisedStream,
    pauseStream: () => teardownDenoisedStream(),
    resumeStream: buildDenoisedStream,
    // Require clearer, more sustained speech before firing, so a stray noise or
    // residual echo doesn't register as the user barging in. (vad-web defaults
    // are ~0.5 / 3 frames.)
    positiveSpeechThreshold: 0.8,
    negativeSpeechThreshold: 0.5,
    minSpeechFrames: 8,
    redemptionFrames: 12,
    preSpeechPadFrames: 4,
  });
}

function createAgent() {
  const selectedVoice = {
    ...voicePresets[0],
    id: tts.value,
    language: language.value,
  };

  const nextAgent = new StreamingVoiceSupportAgent({
    instructions: `${instructions.value}\n\n${langInstruction(language.value)}`,
    voice: selectedVoice,
    // whisper.cpp is utterance-based: send a complete WAV per turn from the VAD's
    // PCM instead of stitching headerless webm chunks (which broke turns 2+).
    sttAudioSource: "vad",
    vadSampleRate: 16000,
    vad: createVADProvider(),
    stt: new WhisperCppSTTProvider({
      baseUrl: "http://localhost:2022",
      language: language.value,
      // The bridge hot-swaps the whisper model to this alias before transcribing.
      model: effectiveSttModel(),
    }),
    llm: new GroqStreamingLLMProvider({
      apiKey: (groqKeyInput.value || localStorage.getItem(GROQ_KEY_STORAGE) || "").trim(),
      model: llm.value,
    }),
    tts: new PiperTTSProvider({
      baseUrl: "http://localhost:5000",
      voice: selectedVoice.id,
    }),
    tools: buildToolDefinitions(),
  });

  nextAgent.on("status", ({ status }) => {
    statusPill.dataset.state = status;
    statusText.textContent = labelForStatus(status);
    statusCopy.textContent = copyForStatus(status);
    voiceArea.classList.toggle("listening", ACTIVE_STATUSES.includes(status));

    // If the agent settled itself (stopped/error/idle), the live session is over.
    if (status === "stopped" || status === "error" || status === "idle") {
      voiceSessionOn = false;
      updateTalkButton();
    }
  });

  // Single source of truth for committed turns. User messages and finalized
  // assistant messages both arrive here; assistant text also streams live via
  // llmToken, so we reconcile the two below.
  nextAgent.on("transcript", ({ message }) => {
    // System instructions and tool-result turns are internal context; tool calls
    // surface to the user via the dedicated tool chip below.
    if (message.role === "system" || message.role === "tool") {
      return;
    }
    if (message.role === "assistant") {
      finalizeAssistant(message.content);
    } else {
      appendMessage(message.role, message.content);
    }
  });

  nextAgent.on("toolCall", ({ toolCall }) => {
    appendToolChip(toolCall);
  });

  nextAgent.on("llmToken", ({ text }) => {
    appendStreamingAssistant(text);
  });

  nextAgent.on("interruption", () => {
    appendNotice("You interrupted the agent.");
  });

  nextAgent.on("error", ({ error }) => {
    stopMicLevelMeter();
    voiceSessionOn = false;
    updateTalkButton();
    statusPill.dataset.state = "error";
    statusText.textContent = "Error";
    statusCopy.textContent = error.message;
    voiceArea.classList.remove("listening");
  });

  return nextAgent;
}

// The live assistant bubble for the current turn (token-streamed), or null
// between turns. Reset when the turn's final assistant message is committed.
let draftAssistant = null;

function clearEmptyState() {
  transcript.querySelector(".empty-state")?.remove();
}

function resetTranscript() {
  draftAssistant = null;
  transcript.innerHTML =
    '<div class="empty-state">No messages yet.<br />Hit <b>Talk</b> and speak to your agent.</div>';
}

function scrollTranscript() {
  transcript.scrollTop = transcript.scrollHeight;
}

function makeBubble(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : "Agent";
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = content;
  node.append(who, body);
  return node;
}

function appendMessage(role, content) {
  clearEmptyState();
  transcript.append(makeBubble(role, content));
  scrollTranscript();
}

// Append a streamed assistant token, creating the live bubble if needed.
function appendStreamingAssistant(text) {
  clearEmptyState();
  if (!draftAssistant) {
    draftAssistant = makeBubble("assistant", "");
    draftAssistant.classList.add("streaming");
    transcript.append(draftAssistant);
  }
  draftAssistant.querySelector(".body").textContent += text;
  scrollTranscript();
}

// Commit the assistant turn: finalize the streamed bubble, or create one if the
// reply never streamed (e.g. a non-streaming path).
function finalizeAssistant(content) {
  if (draftAssistant) {
    draftAssistant.classList.remove("streaming");
    draftAssistant.querySelector(".body").textContent = content;
    draftAssistant = null;
  } else {
    appendMessage("assistant", content);
  }
  scrollTranscript();
}

function appendToolChip(toolCall) {
  clearEmptyState();
  const chip = document.createElement("div");
  chip.className = "tool-chip";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = `🔧 ${toolCall.name}`;
  chip.append(name);
  if (toolCall.result !== undefined) {
    const result = document.createElement("pre");
    result.className = "result";
    result.textContent =
      typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result, null, 2);
    chip.append(result);
  }
  transcript.append(chip);
  scrollTranscript();
}

function appendNotice(text) {
  clearEmptyState();
  const node = document.createElement("div");
  node.className = "notice";
  node.textContent = text;
  transcript.append(node);
  scrollTranscript();
}

function labelForStatus(status) {
  return {
    idle: "Ready",
    listening: "Listening",
    user_speaking: "User speaking",
    transcribing: "Transcribing",
    thinking: "Thinking",
    speaking: "Speaking",
    interrupted: "Interrupted",
    stopped: "Stopped",
    error: "Error",
  }[status] ?? status;
}

function copyForStatus(status) {
  return {
    idle: "Ready when you are. Click the button and ask a support question.",
    listening: "Listening with local open-source services.",
    user_speaking: "Receiving your voice.",
    transcribing: "Whisper.cpp is transcribing the utterance.",
    thinking: "Working through the support flow.",
    speaking: "Groq and Piper are generating the response.",
    interrupted: "Playback was interrupted.",
    stopped: "Session stopped.",
    error: "Something needs attention. Check the service logs and try again.",
  }[status] ?? "Ready.";
}

// Set the status pill + copy directly (for UI events that aren't agent statuses).
function setStatusManual(state, label, copy) {
  statusPill.dataset.state = state;
  statusText.textContent = label;
  statusCopy.textContent = copy;
}

// Resolve the Groq key, persist it, or guide the user to the Model tab if missing.
function ensureKey() {
  const key = (groqKeyInput.value || localStorage.getItem(GROQ_KEY_STORAGE) || "").trim();
  if (!key) {
    setStatusManual(
      "error",
      "Missing key",
      "Add your Groq API key under the Model tab first. Get one at console.groq.com/keys.",
    );
    document.querySelector('.tab[data-tab="model"]').click();
    groqKeyInput.focus();
    return "";
  }
  localStorage.setItem(GROQ_KEY_STORAGE, key);
  return key;
}

// Tear down the current agent and build a fresh one (used on config changes).
function recreateAgent({ ready } = {}) {
  agent.stop().catch(() => undefined);
  stopMicLevelMeter();
  voiceSessionOn = false;
  agent = createAgent();
  updateTalkButton();
  updateContext();
  if (ready) {
    setStatusManual("idle", "Ready", ready);
  }
}

talk.addEventListener("click", () => {
  // Stop a running session.
  if (voiceSessionOn) {
    voiceSessionOn = false;
    updateTalkButton();
    agent.stop().catch(() => undefined);
    stopMicLevelMeter();
    setStatusManual("idle", "Ready", "Session stopped. Hit Talk whenever you're ready.");
    return;
  }

  const key = ensureKey();
  if (!key) {
    return;
  }
  if (key !== lastUsedKey) {
    agent.stop().catch(() => undefined);
    agent = createAgent();
    lastUsedKey = key;
  }

  voiceSessionOn = true;
  updateTalkButton();
  startMicLevelMeter()
    .then(() => agent.start())
    .catch((error) => {
      voiceSessionOn = false;
      updateTalkButton();
      setStatusManual("error", "Error", error.message);
      stopMicLevelMeter();
    });
});

reset.addEventListener("click", () => {
  resetTranscript();
  agent.stop().catch(() => undefined);
  stopMicLevelMeter();
  voiceSessionOn = false;
  agent = createAgent();
  updateTalkButton();
  setStatusManual("idle", "Ready", "Configure the agent on the left, then hit Talk.");
});

tts.addEventListener("change", () => {
  recreateAgent({ ready: `${selectedVoiceLabel()} selected.` });
});

llm.addEventListener("change", () => {
  localStorage.setItem(GROQ_MODEL_STORAGE, llm.value);
  recreateAgent({ ready: `${llm.options[llm.selectedIndex].text} selected.` });
});

language.addEventListener("change", () => {
  populateVoicesForLanguage();
  recreateAgent({ ready: `${language.options[language.selectedIndex].text} selected.` });
});

sttModelSelect.addEventListener("change", () => {
  recreateAgent({ ready: `Transcription model: ${sttModelSelect.options[sttModelSelect.selectedIndex].text}.` });
});

// Initial UI sync.
updateTalkButton();
updateContext();
