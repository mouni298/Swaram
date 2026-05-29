import {
  BrowserVADProvider,
  GroqStreamingLLMProvider,
  PiperTTSProvider,
  StreamingVoiceSupportAgent,
  WhisperCppSTTProvider,
  buildLanguageInstruction,
  ecommerceSupportTemplate,
  getDefaultPiperVoiceForLanguage,
  getPiperVoiceConfig,
  piperVoicePresets,
  supportedLanguages,
  voicePresets,
} from "../../dist/index.js";

const instructions = document.querySelector("#instructions");
const language = document.querySelector("#language");
const transcript = document.querySelector("#transcript");
const statusPill = document.querySelector("#agent-status");
const statusCopy = document.querySelector("#status-copy");
const voiceArea = document.querySelector("#voice-area");
const talk = document.querySelector("#talk");
const reset = document.querySelector("#reset");
const typed = document.querySelector("#typed");
const typedInput = document.querySelector("#typed-input");
const tts = document.querySelector("#tts");
const llm = document.querySelector("#llm");
const groqKeyInput = document.querySelector("#groq-key");
const voiceOrb = document.querySelector(".voice-orb");

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

instructions.value = ecommerceSupportTemplate.instructions;

language.replaceChildren(
  ...supportedLanguages.map((languageConfig) => {
    const option = document.createElement("option");
    option.value = languageConfig.id;
    option.textContent = languageConfig.label;
    return option;
  }),
);

tts.replaceChildren(
  ...piperVoicePresets.map((voice) => {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.label;
    return option;
  }),
);

function selectedPiperVoice() {
  return getPiperVoiceConfig(tts.value) ?? piperVoicePresets[0];
}

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
  });
}

function createAgent() {
  const selectedVoice = {
    ...voicePresets[0],
    ...selectedPiperVoice(),
    language: language.value,
  };

  const nextAgent = new StreamingVoiceSupportAgent({
    instructions: `${instructions.value}\n\n${buildLanguageInstruction(language.value)}`,
    voice: selectedVoice,
    // whisper.cpp is utterance-based: send a complete WAV per turn from the VAD's
    // PCM instead of stitching headerless webm chunks (which broke turns 2+).
    sttAudioSource: "vad",
    vadSampleRate: 16000,
    vad: createVADProvider(),
    stt: new WhisperCppSTTProvider({
      baseUrl: "http://localhost:2022",
      language: language.value,
    }),
    llm: new GroqStreamingLLMProvider({
      apiKey: (groqKeyInput.value || localStorage.getItem(GROQ_KEY_STORAGE) || "").trim(),
      model: llm.value,
    }),
    tts: new PiperTTSProvider({
      baseUrl: "http://localhost:5000",
      voice: selectedVoice.id,
    }),
    tools: ecommerceSupportTemplate.tools,
  });

  nextAgent.on("status", ({ status }) => {
    statusPill.textContent = labelForStatus(status);
    statusCopy.textContent = copyForStatus(status);
    voiceArea.classList.toggle(
      "listening",
      ["listening", "user_speaking", "transcribing", "thinking", "speaking"].includes(status),
    );
    talk.disabled = ["listening", "user_speaking", "transcribing", "thinking", "speaking"].includes(status);
  });

  nextAgent.on("transcript", ({ message }) => {
    if (message.role === "system") {
      return;
    }

    appendMessage(message.role, message.content);
  });

  nextAgent.on("toolCall", ({ toolCall }) => {
    appendMessage("assistant", `Tool call: ${toolCall.name} ${JSON.stringify(toolCall.result)}`);
  });

  nextAgent.on("finalTranscript", ({ text }) => {
    appendMessage("user", text);
  });

  nextAgent.on("llmToken", ({ text }) => {
    appendStreamingAssistant(text);
  });

  nextAgent.on("interruption", ({ reason }) => {
    appendMessage("assistant", `Interrupted: ${reason}`);
  });

  nextAgent.on("error", ({ error }) => {
    stopMicLevelMeter();
    statusPill.textContent = "Error";
    statusCopy.textContent = error.message;
    voiceArea.classList.remove("listening");
    talk.disabled = false;
  });

  return nextAgent;
}

function appendMessage(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  transcript.append(node);
  transcript.scrollTop = transcript.scrollHeight;
}

function appendStreamingAssistant(text) {
  let node = transcript.querySelector(".message.assistant.streaming");
  if (!node) {
    node = document.createElement("div");
    node.className = "message assistant streaming";
    transcript.append(node);
  }

  node.textContent += text;
  transcript.scrollTop = transcript.scrollHeight;
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
    error: "Something needs attention. Try typed input as a fallback.",
  }[status] ?? "Ready.";
}

talk.addEventListener("click", () => {
  const key = (groqKeyInput.value || localStorage.getItem(GROQ_KEY_STORAGE) || "").trim();
  if (!key) {
    statusPill.textContent = "Missing API key";
    statusCopy.textContent = "Enter your Groq API key on the left before talking. Get one at console.groq.com/keys.";
    groqKeyInput.focus();
    return;
  }

  localStorage.setItem(GROQ_KEY_STORAGE, key);
  if (key !== lastUsedKey) {
    agent.stop().catch(() => undefined);
    agent = createAgent();
    lastUsedKey = key;
  }

  startMicLevelMeter()
    .then(() => agent.start())
    .catch((error) => {
      statusPill.textContent = "Error";
      statusCopy.textContent = error.message;
      stopMicLevelMeter();
    });
});

typed.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = typedInput.value.trim();
  typedInput.value = "";
  if (message) {
    appendMessage("user", message);
    statusPill.textContent = "Typed fallback unavailable";
    statusCopy.textContent = "This playground now uses the streaming local voice path. Use the local-streaming demo for lower-level debugging.";
  }
});

reset.addEventListener("click", () => {
  transcript.innerHTML = "";
  agent.stop().catch(() => undefined);
  stopMicLevelMeter();
  agent = createAgent();
  statusPill.textContent = "Ready";
  statusCopy.textContent = "Configure the agent on the left, then talk to it here.";
});

tts.addEventListener("change", () => {
  const selectedVoice = selectedPiperVoice();
  language.value = selectedVoice.language;
  agent.stop().catch(() => undefined);
  stopMicLevelMeter();
  agent = createAgent();
  statusPill.textContent = "Ready";
  statusCopy.textContent = `${selectedVoice.label} selected.`;
});

llm.addEventListener("change", () => {
  localStorage.setItem(GROQ_MODEL_STORAGE, llm.value);
  agent.stop().catch(() => undefined);
  stopMicLevelMeter();
  agent = createAgent();
  statusPill.textContent = "Ready";
  statusCopy.textContent = `${llm.options[llm.selectedIndex].text} selected.`;
});

language.addEventListener("change", () => {
  const matchingVoice = getDefaultPiperVoiceForLanguage(language.value);
  if (matchingVoice) {
    tts.value = matchingVoice.id;
  }

  agent.stop().catch(() => undefined);
  stopMicLevelMeter();
  agent = createAgent();
  statusPill.textContent = "Ready";
  statusCopy.textContent = `${language.options[language.selectedIndex].text} selected.`;
});
