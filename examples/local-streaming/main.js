import {
  BrowserVADProvider,
  OllamaStreamingLLMProvider,
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

const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");
const events = document.querySelector("#events");
const language = document.querySelector("#language");
const voice = document.querySelector("#voice");
const start = document.querySelector("#start");

language.replaceChildren(
  ...supportedLanguages.map((languageConfig) => {
    const option = document.createElement("option");
    option.value = languageConfig.id;
    option.textContent = languageConfig.label;
    return option;
  }),
);

voice.replaceChildren(
  ...piperVoicePresets.map((voiceConfig) => {
    const option = document.createElement("option");
    option.value = voiceConfig.id;
    option.textContent = voiceConfig.label;
    return option;
  }),
);

function append(target, label, value) {
  const item = document.createElement("pre");
  item.textContent = `${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
  target.prepend(item);
}

function selectedPiperVoice() {
  return getPiperVoiceConfig(voice.value) ?? piperVoicePresets[0];
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
    template: ecommerceSupportTemplate,
    instructions: `${ecommerceSupportTemplate.instructions}\n\n${buildLanguageInstruction(language.value)}`,
    voice: selectedVoice,
    vad: createVADProvider(),
    stt: new WhisperCppSTTProvider({
      baseUrl: "http://localhost:2022",
      language: language.value,
    }),
    llm: new OllamaStreamingLLMProvider({
      baseUrl: "http://localhost:11434",
      model: "llama3.1:8b",
    }),
    tts: new PiperTTSProvider({
      baseUrl: "http://localhost:5000",
      voice: selectedVoice.id,
    }),
  });

  nextAgent.on("status", (event) => {
    status.textContent = event.status;
    start.disabled = ["listening", "user_speaking", "transcribing", "thinking", "speaking"].includes(event.status);
  });
  nextAgent.on("partialTranscript", (event) => append(transcript, "partial", event.text));
  nextAgent.on("finalTranscript", (event) => append(transcript, "final", event.text));
  nextAgent.on("llmToken", (event) => append(events, "llmToken", event.text));
  nextAgent.on("toolCall", (event) => append(events, "toolCall", event.toolCall));
  nextAgent.on("interruption", (event) => append(events, "interruption", event));
  nextAgent.on("error", (event) => append(events, "error", event.error.message));

  return nextAgent;
}

let agent = createAgent();

function resetAgent() {
  agent.stop().catch(() => undefined);
  agent = createAgent();
}

start.addEventListener("click", () => {
  agent.start().catch((error) => append(events, "start error", error.message));
});

document.querySelector("#interrupt").addEventListener("click", () => {
  agent.interrupt();
});

document.querySelector("#stop").addEventListener("click", () => {
  agent.stop().catch((error) => append(events, "stop error", error.message));
});

voice.addEventListener("change", () => {
  const selectedVoice = selectedPiperVoice();
  language.value = selectedVoice.language;
  resetAgent();
  append(events, "voice", selectedVoice.label);
});

language.addEventListener("change", () => {
  const matchingVoice = getDefaultPiperVoiceForLanguage(language.value);
  if (matchingVoice) {
    voice.value = matchingVoice.id;
  }

  resetAgent();
  append(events, "language", language.options[language.selectedIndex].text);
});
