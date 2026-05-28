import {
  BrowserVADProvider,
  CartesiaStreamingTTSProvider,
  DeepgramStreamingSTTProvider,
  OpenAIStreamingLLMProvider,
  StreamingVoiceSupportAgent,
  ecommerceSupportTemplate,
  voicePresets,
} from "../../dist/index.js";

const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");
const events = document.querySelector("#events");

function append(target, label, value) {
  const item = document.createElement("pre");
  item.className = "item";
  item.textContent = `${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
  target.prepend(item);
}

const agent = new StreamingVoiceSupportAgent({
  template: ecommerceSupportTemplate,
  voice: voicePresets[0],
  vad: new BrowserVADProvider(),
  stt: new DeepgramStreamingSTTProvider({
    apiKey: "REPLACE_WITH_EPHEMERAL_DEEPGRAM_KEY",
  }),
  llm: new OpenAIStreamingLLMProvider({
    bridgeUrl: "http://localhost:8787/llm",
  }),
  tts: new CartesiaStreamingTTSProvider({
    apiKey: "REPLACE_WITH_EPHEMERAL_CARTESIA_KEY",
    voiceId: "REPLACE_WITH_CARTESIA_VOICE_ID",
  }),
});

agent.on("status", (event) => {
  status.textContent = event.status;
});
agent.on("partialTranscript", (event) => append(transcript, "partial", event.text));
agent.on("finalTranscript", (event) => append(transcript, "final", event.text));
agent.on("llmToken", (event) => append(events, "llmToken", event.text));
agent.on("toolCall", (event) => append(events, "toolCall", event.toolCall));
agent.on("interruption", (event) => append(events, "interruption", event));
agent.on("error", (event) => append(events, "error", event.error.message));

document.querySelector("#start").addEventListener("click", () => {
  agent.start().catch((error) => append(events, "start error", error.message));
});

document.querySelector("#interrupt").addEventListener("click", () => {
  agent.interrupt();
});

document.querySelector("#stop").addEventListener("click", () => {
  agent.stop().catch((error) => append(events, "stop error", error.message));
});
