# Swaram AI — SDK Guide

Swaram AI is a TypeScript SDK for building **voice support agents**. It owns the
orchestration layer — speech-to-text, model reasoning, tool calls, text-to-speech,
transcript state, and events — and lets you plug in providers for each stage.

The same agent core runs in two deployment shapes:

| Guide | Use it for | Entry point |
|-------|-----------|-------------|
| [Browser & real-time voice](./browser.md) | In-app voice (mic → speaker) in the browser, with barge-in | `StreamingVoiceSupportAgent` |
| [Telephony (phone calls)](./telephony.md) | Inbound/outbound phone calls over Twilio ConversationRelay | `TextVoiceAgent` + telephony helpers |

Read this page first for the concepts both share, then jump to the guide for your
transport.

---

## Install

```bash
npm install swaram-ai
```

- **Node 18+** (uses the global `fetch` / `AbortSignal`). ESM-only.
- The phone transport's `ws` and `twilio` are **optional peer dependencies** —
  install them only if you build the telephony server.

```bash
npm install ws twilio   # only for the phone transport
```

Build before running the bundled examples:

```bash
npm run build
```

---

## Architecture

Both transports drive the same pipeline; they differ in **who owns the audio**.

**Browser** — the SDK owns the full audio loop:

```
mic → VAD → STT → LLM (+ tools) → TTS → AudioPlaybackQueue → speaker
```

**Telephony** — Twilio owns STT/TTS/barge-in; the SDK owns the brains:

```
caller ⇄ Twilio (STT + TTS + barge-in) ⇄ WebSocket ⇄ TextVoiceAgent (LLM + tools)
```

Each stage is a swappable **provider**. You can mix local/open-source providers
(Whisper.cpp, Ollama, Piper) with cloud ones (Deepgram, Groq, Anthropic, Cartesia).

---

## Core concepts

### Agents

- **`StreamingVoiceSupportAgent`** — the real-time browser agent. Manages the mic,
  VAD, streaming STT/TTS, playback, barge-in, and a status state machine.
- **`TextVoiceAgent`** — a headless, transport-agnostic turn engine: text in,
  streamed text out, with the same LLM + tool loop and no audio. This is what a
  phone transport (which does its own STT/TTS) plugs into.
- **`VoiceSupportAgent`** — a simpler non-streaming, turn-at-a-time agent (used by
  the basic browser demo).

### Providers

A provider is a small object implementing a capability. The agent calls them; you
construct and inject them.

| Kind | Interface | Built-in implementations |
|------|-----------|--------------------------|
| Voice activity | `VADProvider` | `BrowserVADProvider` |
| Speech-to-text | `StreamingSTTProvider` / `STTProvider` | `WhisperCppSTTProvider`, `DeepgramStreamingSTTProvider`, `BrowserSTTProvider` |
| Language model | `StreamingLLMProvider` / `LLMProvider` | `GroqStreamingLLMProvider` (default), `AnthropicStreamingLLMProvider`, `OllamaStreamingLLMProvider`, `HttpBridgeLLMProvider` |
| Text-to-speech | `StreamingTTSProvider` / `TTSProvider` | `PiperTTSProvider`, `CartesiaStreamingTTSProvider`, `BrowserTTSProvider` |

Provider API keys can be passed to the constructor or read from a conventional
env var (`GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`).

### Templates

A `SupportTemplate` bundles a domain's `instructions`, `tools`, and starter prompts.
`ecommerceSupportTemplate` is the included example (a QuickKart support rep). The
SDK itself is domain-agnostic — swap the template to change the agent's job.

### Tools & function calling

Tools are how the agent *does things*. A `ToolDefinition` declares a JSON Schema
for its arguments; when present, the SDK advertises it to the model via the
provider's **native function-calling** API.

```ts
const lookupOrder = {
  name: "lookup_order",
  description: "Look up the current shipping status for an order.",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string", description: "The customer's order ID." } },
    required: ["orderId"],
  },
  run: async ({ orderId }) => fetchOrderStatus(orderId),
};
```

The loop is **tool-result-grounded**:

1. The model emits a tool call.
2. The SDK runs `run(args, context)`.
3. The result is fed back into the conversation.
4. The model is re-prompted and produces the spoken answer.

This repeats until a turn makes no tool calls (capped at 4 rounds). Some models
emit tool calls as text (`<function=name>{…}`) rather than the structured field;
the SDK detects and converts those formats too, so they never get spoken.

### Events

Subscribe with `agent.on(event, handler)`. `on` returns an unsubscribe function.

`StreamingVoiceSupportAgent` emits: `status`, `speechStart`, `speechEnd`,
`partialTranscript`, `finalTranscript`, `llmToken`, `interruption`, `audioStart`,
`audioEnd`, `transcript`, `toolCall`, `error`.

`TextVoiceAgent` emits: `token`, `transcript`, `toolCall`, `turnEnd`, `error`.

> Note: `transcript` events include internal `system` and `tool` role messages —
> filter those out before rendering them in a UI.

### Errors

Failures surface as a typed `SwaramError`:

```ts
import { SwaramError } from "swaram-ai";

agent.on("error", ({ error }) => {
  if (error instanceof SwaramError) {
    console.error(error.code, error.status, error.message);
  }
});
```

Codes: `AUTH`, `RATE_LIMITED`, `TIMEOUT`, `HTTP_ERROR`, `PROVIDER_FAILURE`,
`TURN_ABORTED`, `CONCURRENT_TURN`, `EMPTY_INPUT`, `UNKNOWN_TOOL`, `DUPLICATE_TOOL`,
`STT_UNSUPPORTED`, `TTS_UNSUPPORTED`, `LLM_UNSUPPORTED`. HTTP providers apply a
connect timeout and retry transient failures (429/5xx) with exponential backoff;
`error.status` carries the HTTP status when relevant.

---

## Next steps

- **[Browser & real-time voice →](./browser.md)**
- **[Telephony (phone calls) →](./telephony.md)**
