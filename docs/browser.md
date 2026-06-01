# Browser & Real-Time Voice

Build an in-app voice agent that listens through the microphone, thinks, calls
tools, and speaks back — with barge-in — entirely driven by the SDK.

Entry point: **`StreamingVoiceSupportAgent`**.

> New here? Read the [SDK Guide](./README.md) first for concepts (providers,
> tools, events, errors).

---

## The pipeline

```
mic → VAD → STT → LLM (+ tools) → TTS → AudioPlaybackQueue → speaker
```

- **VAD** detects when the user starts/stops talking and arms barge-in.
- **STT** transcribes each utterance.
- **LLM** streams the reply token-by-token and decides tool calls.
- **TTS** synthesizes audio, which the **AudioPlaybackQueue** plays in order.

When the user speaks while the agent is talking, the agent aborts the in-flight
LLM stream and audio, emits `interruption`, and starts listening again.

---

## Quickstart

The default cloud stack streams through Groq. STT/TTS here use the local
open-source services (Whisper.cpp + Piper); swap in cloud providers if you prefer.

```ts
import {
  BrowserVADProvider,
  GroqStreamingLLMProvider,
  PiperTTSProvider,
  StreamingVoiceSupportAgent,
  WhisperCppSTTProvider,
  ecommerceSupportTemplate,
  voicePresets,
} from "swaram-ai";

const agent = new StreamingVoiceSupportAgent({
  template: ecommerceSupportTemplate,        // instructions + tools for the domain
  voice: voicePresets[0],
  vad: new BrowserVADProvider(),
  stt: new WhisperCppSTTProvider({ baseUrl: "http://localhost:2022" }),
  llm: new GroqStreamingLLMProvider({
    apiKey: process.env.GROQ_API_KEY,         // or set GROQ_API_KEY
    model: "llama-3.1-8b-instant",            // configurable
  }),
  tts: new PiperTTSProvider({ baseUrl: "http://localhost:5000" }),
});

agent.on("status", ({ status }) => console.log(status));
agent.on("partialTranscript", ({ text }) => console.log("…", text));
agent.on("transcript", ({ message }) => {
  if (message.role !== "system" && message.role !== "tool") {
    console.log(message.role, message.content);
  }
});
agent.on("llmToken", ({ text }) => process.stdout.write(text));
agent.on("toolCall", ({ toolCall }) => console.log("tool:", toolCall.name, toolCall.result));
agent.on("interruption", ({ reason }) => console.log("interrupted:", reason));
agent.on("error", ({ error }) => console.error(error));

await agent.start();   // requests the mic and begins listening
// …later…
await agent.stop();
```

---

## Configuration (`StreamingVoiceSupportAgentConfig`)

| Field | Type | Notes |
|-------|------|-------|
| `vad` | `VADProvider` | Required. |
| `stt` | `StreamingSTTProvider` | Required. |
| `llm` | `StreamingLLMProvider` | Required. |
| `tts` | `StreamingTTSProvider` | Required. |
| `instructions` | `string` | System prompt. Falls back to `template.instructions`. |
| `template` | `SupportTemplate` | Supplies instructions + tools. |
| `voice` | `VoiceConfig` | `{ id, label?, language?, rate?, pitch? }`. |
| `tools` | `ToolDefinition[]` | Merged with the template's tools. |
| `mediaStream` | `MediaStream` | Provide your own mic stream (e.g. a denoised one). |
| `sttAudioSource` | `"mediaRecorder" \| "vad"` | How utterance audio reaches the STT (see below). |
| `vadSampleRate` | `number` | Sample rate of the VAD's PCM. Default `16000`. |

### `sttAudioSource`

- **`"mediaRecorder"`** (default): a continuous `MediaRecorder` streams WebM chunks
  to the STT. Right for socket-streaming STT (e.g. Deepgram).
- **`"vad"`**: each utterance's PCM from the VAD is encoded to a standalone WAV and
  sent on speech-end. Right for utterance-based STT (e.g. Whisper.cpp), and avoids
  the headerless-WebM problem on turns after the first.

---

## Methods

| Method | Description |
|--------|-------------|
| `start()` | Request the mic, connect providers, begin listening. |
| `stop()` | Stop providers and playback; status → `stopped`. |
| `interrupt()` | Manually barge in (abort the current reply). |
| `sendText(text)` | Drive a turn from typed text (works with or without a live mic). |
| `getStatus()` | Current `StreamingAgentStatus`. |
| `getTranscript()` | Copy of the transcript. |
| `getToolCalls()` | Copy of executed tool calls. |
| `on(event, handler)` | Subscribe; returns an unsubscribe function. |

### Status machine

`idle → listening → user_speaking → transcribing → thinking → speaking → …`
plus `interrupted`, `stopped`, `error`. Drive your UI off the `status` event.

---

## Events

| Event | Payload | Fires when |
|-------|---------|-----------|
| `status` | `{ status }` | The agent's status changes. |
| `speechStart` / `speechEnd` | `{}` | VAD detects the user start/stop talking. |
| `partialTranscript` | `{ text }` | Interim STT result. |
| `finalTranscript` | `{ text }` | Final STT result for the utterance. |
| `llmToken` | `{ text }` | Each streamed LLM token (use for live captions). |
| `transcript` | `{ message, transcript }` | A turn is committed (incl. `system`/`tool` — filter). |
| `toolCall` | `{ toolCall }` | A tool finished running. |
| `interruption` | `{ reason: "barge_in" \| "manual" }` | The user barged in. |
| `audioStart` / `audioEnd` | `{}` | Playback of the reply starts/ends. |
| `error` | `{ error }` | A `SwaramError` (the session tears down). |

---

## Choosing providers

### Local-first (open-source)

```ts
import { WhisperCppSTTProvider, OllamaStreamingLLMProvider, PiperTTSProvider } from "swaram-ai";

stt: new WhisperCppSTTProvider({ baseUrl: "http://localhost:2022" }),
llm: new OllamaStreamingLLMProvider({ baseUrl: "http://localhost:11434", model: "llama3.1:8b" }),
tts: new PiperTTSProvider({ baseUrl: "http://localhost:5000" }),
```

### Cloud streaming

```ts
import {
  DeepgramStreamingSTTProvider,
  GroqStreamingLLMProvider,
  AnthropicStreamingLLMProvider,
  CartesiaStreamingTTSProvider,
} from "swaram-ai";

stt: new DeepgramStreamingSTTProvider({ apiKey: "…", model: "nova-3" }),   // sttAudioSource: "mediaRecorder"
llm: new GroqStreamingLLMProvider({ apiKey: "…", model: "llama-3.1-8b-instant" }),
// or: new AnthropicStreamingLLMProvider({ apiKey: "…", model: "claude-haiku-4-5-20251001" }),
tts: new CartesiaStreamingTTSProvider({ apiKey: "…", voiceId: "…" }),
```

### Browser-native (no servers, support varies)

`BrowserSTTProvider`, `BrowserTTSProvider` use the Web Speech APIs — handy for a
zero-backend demo, but quality and availability depend on the browser.

---

## Adding tools

Pass `tools` (merged with the template's). Each tool's `parameters` JSON Schema is
advertised to the model; the result is fed back so the spoken answer is grounded.

```ts
const agent = new StreamingVoiceSupportAgent({
  instructions: "You are a helpful assistant.",
  vad, stt, llm, tts,
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      run: async ({ city }) => {
        const res = await fetch(`https://api.example.com/weather?city=${encodeURIComponent(city)}`);
        return res.json();
      },
    },
  ],
});
```

The **minimal-playground** example ships a **Tools** tab that builds tools like this
from a UI (mock result or webhook) — see `examples/minimal-playground/`.

---

## Microphone & noise

`start()` will call `navigator.mediaDevices.getUserMedia` for you. To control the
mic (e.g. run RNNoise denoising first), build your own `MediaStream` and pass it as
`mediaStream`, or supply a VAD configured with a custom stream. The
`examples/minimal-playground/main.js` file shows a full denoised-mic pipeline and a
tuned `BrowserVADProvider` (thresholds, redemption frames) to avoid false barge-ins.

---

## Run the example

```bash
npm run build
# serve the repo root with any static server, then open:
#   examples/minimal-playground/index.html
```

The playground needs the local services running (Whisper.cpp on :2022, Piper on
:5000) and a Groq API key entered in the **Model** tab. See the project README's
"Minimal Playground UI" section.

---

## Troubleshooting

- **No audio / silent replies** — check the TTS service is reachable and the
  `error` event for a `SwaramError`.
- **Barge-in triggers on background noise** — raise the VAD's
  `positiveSpeechThreshold` / `minSpeechFrames`, or denoise the mic stream.
- **`AUTH` error** — missing/invalid LLM key; set it on the provider or via the
  env var.
- **Tool call spoken aloud instead of executed** — make sure the tool declares
  `parameters`; the SDK also auto-converts textual `<function=…>` calls, so rebuild
  if you're on an older `dist/`.
