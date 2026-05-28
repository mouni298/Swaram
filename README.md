# Swaram AI

Swaram AI is a TypeScript SDK for building voice support agents. It is inspired by the developer experience of platforms like Vapi, but the SDK owns the orchestration layer directly: speech-to-text, model reasoning, tool calls, text-to-speech, transcript state, and events.

The SDK is domain-agnostic. E-commerce support is included only as the first example template.

## Install

```bash
npm install swaram-ai
```

## Quickstart

```ts
import {
  BrowserVADProvider,
  OllamaStreamingLLMProvider,
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
  llm: new OllamaStreamingLLMProvider({
    baseUrl: "http://localhost:11434",
    model: "llama3.1:8b",
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

## Core Concepts

- `VoiceSupportAgent`: coordinates the full support-agent turn.
- `STTProvider`: converts speech to text.
- `LLMProvider`: decides the assistant response and tool calls.
- `ToolDefinition`: runs business logic.
- `TTSProvider`: speaks the assistant response.
- `SupportTemplate`: optional starter instructions and tools for a domain.

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

Hosted provider examples still exist under `examples/streaming-browser` and `examples/server-bridge`, but they are optional.

## Roadmap

- Kokoro TTS adapter for higher-quality local voices.
- True local partial STT streaming when the chosen Whisper server supports it reliably.
- Interruptions and barge-in.
- Phone-call transport.
- More support templates.
