# Swaram AI

Swaram AI is a TypeScript SDK for building voice support agents. It is inspired by the developer experience of platforms like Vapi, but the SDK owns the orchestration layer directly: speech-to-text, model reasoning, tool calls, text-to-speech, transcript state, and events.

The SDK is domain-agnostic. E-commerce support is included only as the first example template.

## Install

```bash
npm install swaram-ai
```

Requires Node 18+ (uses the global `fetch`/`AbortSignal`). The package is
ESM-only. The phone transport's `ws`/`twilio` are optional peer dependencies —
install them only if you use the ConversationRelay example.

## Quickstart

The default cloud stack uses Groq for low-latency streaming. The model is
configurable; an API key can come from the constructor or the `GROQ_API_KEY`
environment variable.

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
  template: ecommerceSupportTemplate,
  voice: voicePresets[0],
  vad: new BrowserVADProvider(),
  stt: new WhisperCppSTTProvider({
    baseUrl: "http://localhost:2022",
  }),
  llm: new GroqStreamingLLMProvider({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.1-8b-instant", // configurable
  }),
  tts: new PiperTTSProvider({
    baseUrl: "http://localhost:5000",
  }),
});

agent.on("status", ({ status }) => console.log(status));
agent.on("transcript", ({ message }) => console.log(message));
agent.on("toolCall", ({ toolCall }) => console.log(toolCall));
agent.on("error", ({ error }) => console.error(error));

await agent.start();
```

Other LLM providers ship in the box: `OllamaStreamingLLMProvider` (local-first),
`AnthropicStreamingLLMProvider` (native tools + prompt caching), and
`HttpBridgeLLMProvider` (talk to your own server-side bridge to keep vendor keys
off the client).

## Core Concepts

- `VoiceSupportAgent`: coordinates the full support-agent turn.
- `STTProvider`: converts speech to text.
- `LLMProvider`: decides the assistant response and tool calls.
- `ToolDefinition`: runs business logic.
- `TTSProvider`: speaks the assistant response.
- `SupportTemplate`: optional starter instructions and tools for a domain.

## Tools & function calling

A tool declares a JSON Schema for its arguments via `parameters`. When present,
the SDK advertises it to the model using the provider's native function-calling
API (Groq/OpenAI-style `tools`, Anthropic `tools`, Ollama `tools`). Providers
without a declared schema fall back to a prompt-based JSON convention.

```ts
const tool = {
  name: "lookup_order",
  description: "Look up the current shipping status for an order.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  run: async ({ orderId }) => fetchOrderStatus(orderId),
};
```

Tool results are fed back into the conversation and the model is re-prompted, so
the spoken answer is grounded in what the tool returned. The loop runs until a
turn makes no further tool calls (capped to avoid runaways).

## Error handling

Provider and agent failures surface as a typed `SwaramError` with a `code`
(`AUTH`, `RATE_LIMITED`, `TIMEOUT`, `HTTP_ERROR`, `PROVIDER_FAILURE`,
`TURN_ABORTED`, …) and, for HTTP failures, the `status`. HTTP providers apply a
connect timeout and retry transient failures with exponential backoff.

```ts
import { SwaramError } from "swaram-ai";

agent.on("error", ({ error }) => {
  if (error instanceof SwaramError && error.code === "AUTH") {
    // bad or missing API key
  }
});
```

## Streaming Voice Agents

V2 adds a streaming runtime for English voice support agents. The default stack is open-source/local-first:

```txt
Browser microphone
  -> BrowserVADProvider
  -> WhisperCppSTTProvider
  -> OllamaStreamingLLMProvider
  -> PiperTTSProvider
  -> AudioPlaybackQueue
```

```ts
import {
  BrowserVADProvider,
  OllamaStreamingLLMProvider,
  PiperTTSProvider,
  StreamingVoiceSupportAgent,
  WhisperCppSTTProvider,
  ecommerceSupportTemplate,
} from "swaram-ai";

const agent = new StreamingVoiceSupportAgent({
  template: ecommerceSupportTemplate,
  vad: new BrowserVADProvider(),
  stt: new WhisperCppSTTProvider({
    baseUrl: "http://localhost:2022",
  }),
  llm: new OllamaStreamingLLMProvider({
    baseUrl: "http://localhost:11434",
    model: "llama3.1:8b",
  }),
  tts: new PiperTTSProvider({
    baseUrl: "http://localhost:5000",
  }),
});

agent.on("partialTranscript", ({ text }) => console.log(text));
agent.on("interruption", ({ reason }) => console.log(reason));

await agent.start();
```

The streaming runtime supports speech-start/speech-end events, final transcripts, LLM token events, TTS audio events, and interruption handling. Whisper.cpp is used as utterance-based STT first: VAD segments the user turn, then Whisper transcribes that utterance after speech end.

## Browser Demo

Build the SDK first:

```bash
npm run build
```

Then serve the repo root with any static server and open:

```txt
examples/browser-basic/index.html
```

The browser demo uses native Web Speech APIs, so support varies by browser. Typed fallback is included.

## Minimal Playground UI

After `npm run build`, open:

```txt
examples/minimal-playground/index.html
```

This is a small Deepgram-style playground UI with:

- language selector
- transcription selector
- default LLM selector
- editable instructions
- animated voice area
- talk button
- transcript

It uses the local open-source streaming stack: Whisper.cpp, Ollama, and Piper. Start those local services before using the Talk button.

## Local Streaming Demo

After `npm run build`, open:

```txt
examples/local-streaming/index.html
```

The local streaming demo expects:

- whisper.cpp server at `http://localhost:2022`
- Ollama at `http://localhost:11434`
- Piper HTTP server at `http://localhost:5000`

Pull the default local LLM:

```bash
ollama pull llama3.1:8b
```

Hosted/cloud provider examples still exist under `examples/streaming-browser` and `examples/server-bridge` (the latter uses `HttpBridgeLLMProvider` to keep vendor keys server-side), but they are optional.

## Roadmap

- True local partial STT streaming when the chosen Whisper server supports it reliably.
- Full tool_call_id round-tripping for providers that require it (today tool results are fed back as model context).
- Subpath exports for finer-grained tree-shaking.
- More support templates.

Shipped: interruptions/barge-in, phone-call transport (Twilio ConversationRelay),
native function calling, and a typed error model.
