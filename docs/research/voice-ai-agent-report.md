# Voice AI Agent Research Report

Date: 2026-05-20

## Executive Summary

A voice AI agent is a real-time conversational system that listens to user speech, reasons over the conversation and business context, calls tools when needed, and replies with synthesized speech. The current market has two dominant implementation patterns:

1. **Native speech-to-speech realtime models**: A multimodal model consumes live audio and emits live audio. This is the best fit for natural conversations, low latency, barge-in, and expressive turn-taking.
2. **Chained voice pipeline**: The application explicitly wires speech-to-text, LLM reasoning, tools/RAG, and text-to-speech. This is the best fit for controllability, debugging, regulated workflows, custom model choice, and existing text-agent reuse.

For a first production-oriented build, the conservative recommendation is:

- Use **LiveKit Agents** or **OpenAI Realtime Agents SDK** for the realtime transport and agent loop.
- Use **OpenAI Realtime** or **Gemini Live API** if natural conversation quality is the top priority.
- Use a **chained pipeline** with Deepgram or Cartesia STT, OpenAI/Gemini/Anthropic LLM, and Cartesia/ElevenLabs TTS when you need stronger observability, domain-specific validation, or predictable workflow control.
- Use **Twilio Media Streams** or LiveKit SIP for phone calls; use WebRTC directly for browser/mobile.

## How Voice AI Agents Work

At runtime, a voice agent manages six loops at once:

1. **Audio input**: Capture microphone, browser, mobile, SIP, or phone-call audio.
2. **Turn detection**: Decide when the user has finished speaking. This combines VAD, STT endpointing, semantic turn detection, and interruption logic.
3. **Understanding**: Either transcribe the user and feed text to an LLM, or send raw audio directly to a realtime multimodal model.
4. **Reasoning and action**: Maintain conversation state, apply instructions, retrieve knowledge, call APIs, and validate critical data.
5. **Speech output**: Stream synthesized voice back as soon as possible.
6. **Observability and control**: Log transcripts, audio timing, tool calls, failures, latency, user sentiment, and task completion.

AWS describes the classical pattern as voice input -> STT -> streaming/telephony context -> LLM reasoning -> TTS voice response, with optional RAG, session memory, and traceability services. That pattern is still the baseline architecture for controlled business workflows. OpenAI’s docs frame the key design choice similarly: either let the model handle live audio directly or explicitly chain STT, text reasoning, and TTS.

## Architecture Option 1: Native Speech-to-Speech

In this architecture, the model receives audio and produces audio directly.

Typical flow:

1. Server creates an ephemeral session token.
2. Browser/mobile client connects to the realtime model using WebRTC or WebSocket.
3. Client streams microphone audio.
4. Model handles speech understanding, turn-taking, interruptions, tools, and audio response.
5. App receives events for transcripts, tool calls, session updates, and final responses.

Strengths:

- Lowest conceptual complexity for natural voice UX.
- Better barge-in and conversational rhythm.
- Can preserve paralinguistic signals like tone, hesitation, and emphasis.
- Easier browser UX when WebRTC is supported.

Weaknesses:

- Less transparent than a text-first pipeline.
- Harder to apply deterministic validation at every stage.
- Vendor model capabilities determine much of the behavior.
- Debugging audio-native reasoning can be harder than debugging transcripts and intermediate text.

Best fit:

- Voice companions, tutors, live support triage, multilingual voice UX, games/NPCs, accessibility, and demos where naturalness matters.

Representative products:

- **OpenAI Realtime API / Agents SDK**: OpenAI recommends speech-to-speech live sessions when agents need barge-in, low first-audio latency, natural turn-taking, and realtime tool use.
- **Google Gemini Live API**: Supports low-latency voice and vision interactions, raw PCM audio input/output, stateful WebSocket protocol, barge-in, tool use, transcripts, proactive audio, and affective dialog.
- **Hume EVI**: A speech-to-speech interface focused on emotional/prosodic understanding, end-of-turn detection, interruptibility, and empathic response style.

## Architecture Option 2: Chained STT -> LLM -> TTS Pipeline

In this architecture, each stage is explicit and swappable.


Typical flow:

1. Audio capture via WebRTC, WebSocket, SIP, or telephony provider.
2. VAD and noise suppression detect speech and reduce background noise.
3. Streaming STT produces partial and final transcripts.
4. Orchestrator updates state and decides whether the LLM should respond.
5. LLM streams tokens, calls tools, and returns structured outputs when needed.
6. TTS starts speaking from streamed text chunks.
7. Playback layer supports interruption, cancellation, and audio buffering.

Strengths:

- Better observability and auditability.
- Fine-grained provider choice for STT, LLM, TTS, translation, RAG, and telephony.
- Easier to validate critical fields like names, dates, amounts, addresses, SKUs, and appointments.
- Reuses existing text agents and business workflow code.

Weaknesses:

- More moving parts and higher integration complexity.
- Latency must be aggressively managed across every hop.
- Turn detection and barge-in are application responsibilities.
- Audio format conversion is common, especially for telephony.

Best fit:

- Customer support, appointment scheduling, order taking, call-center automation, regulated workflows, enterprise integrations, and cases where correctness beats naturalness.

Representative products:

- **LiveKit Agents**: Provides agent sessions that can combine STT, LLM, TTS, VAD, turn detection, telephony, WebRTC, and model plugins. Its quickstart shows a pipeline using Deepgram STT, OpenAI LLM, Cartesia TTS, Silero VAD, and multilingual turn detection.
- **Deepgram Voice Agent API**: Handles listening, thinking, and speaking over a single WebSocket while still exposing configuration for STT models, LLM providers, TTS voices, endpointing, audio formats, function calling, and multi-agent handoffs.
- **AWS pattern**: Uses Lex or Transcribe for STT, Polly for TTS, Chime/Connect/IVS for streaming or telephony, Bedrock for reasoning, Lambda for glue, and CloudWatch/X-Ray for observability.

## Product and Platform Notes

### OpenAI

OpenAI’s voice-agent docs define two architectures: speech-to-speech live audio sessions and chained voice pipelines. For TypeScript/browser apps, OpenAI points to `RealtimeAgent` and `RealtimeSession`; for Python, it points to chained `VoicePipeline` for extending text agents into voice.

Use OpenAI when:

- You want a strong first-party realtime model and tools.
- You are building browser-based voice UX.
- You want integrated tool calls, handoffs, and session control.

### Google Gemini Live API

Gemini Live API is a stateful WebSocket API for realtime audio, image, and text input with audio output. The docs list barge-in, tool use, audio transcripts, proactive audio, and affective dialog as voice-agent features. Tool use supports function calling and Google Search, but tool responses must be handled by the client.

Use Gemini Live when:

- You want realtime voice plus vision.
- Google ecosystem integration matters.
- You need broad multilingual support.

### LiveKit

LiveKit is a strong framework choice when you want ownership of the voice stack. It supports both realtime models and chained STT-LLM-TTS pipelines. It also has transport, rooms, WebRTC, SIP/telephony, VAD, turn detection, testing, deployment, and model-provider plugins.

Use LiveKit when:

- You need production WebRTC or SIP infrastructure.
- You want to swap STT/LLM/TTS providers.
- You need a framework rather than a single model API.

### Deepgram

Deepgram’s Voice Agent API provides a single WebSocket for the full listen-think-speak loop while allowing configuration of STT, LLM, TTS, endpointing, audio formats, function calling, and multi-agent architecture.

Use Deepgram when:

- Streaming STT quality and telephony audio are central.
- You want an integrated voice pipeline but still want configurable components.

### ElevenLabs

ElevenLabs ElevenAgents focuses on voice-rich agents, web/mobile SDKs, workflows, knowledge bases, tools, personalization, SIP, Twilio integration, WebSocket API, events, testing, experiments, and conversation analytics.

Use ElevenLabs when:

- Voice quality and fast deployment matter.
- You want a managed conversational AI platform with strong TTS roots.
- You need web widgets, mobile SDKs, telephony integration, and built-in analytics.

### Twilio

Twilio is usually the telephony layer, not the full agent brain. Bidirectional Media Streams let a WebSocket app receive call audio and send audio back to the call, which is exactly what a phone voice agent needs. Twilio notes that a bidirectional stream is one WebSocket connection per call.

Use Twilio when:

- You need PSTN phone numbers, inbound/outbound calling, DTMF, call routing, or contact-center connectivity.

### Hume EVI

Hume EVI is a speech-to-speech product optimized around emotional/prosodic signals. It provides transcripts, streamed speech generation, low latency, tone-aware turn-taking, interruption support, and multilingual support in EVI 4-mini.

Use Hume when:

- Emotional tone, empathy, and prosody are core to the product.

### Cartesia

Cartesia is primarily a voice model provider: Sonic for realtime streaming TTS and Ink for streaming STT. Its docs emphasize low-latency TTS, voice cloning, pronunciation/accent control, and STT optimized for telephony artifacts, noise, accents, and proper nouns.

Use Cartesia when:

- You are composing your own pipeline and want fast, expressive TTS or realtime STT.

## Recommended Tech Stack

### MVP: Browser Voice Agent

- Frontend: Next.js or React
- Transport: WebRTC
- Agent runtime: OpenAI Agents SDK Realtime or LiveKit Agents
- Model: OpenAI realtime model or Gemini Live
- Tools: Server-side REST endpoints for app actions
- Auth: Server-generated ephemeral realtime tokens
- Storage: Postgres for conversations, tool results, user profile, and audit events
- Observability: structured logs for session events, latency, transcript, tool calls, and interruption count

### MVP: Phone Voice Agent

- Telephony: Twilio Media Streams or LiveKit SIP
- Backend: Node.js/Fastify or Python/FastAPI WebSocket server
- Audio handling: mu-law 8kHz for PSTN, transcode to PCM 16kHz/24kHz as provider requires
- STT: Deepgram, Cartesia Ink, OpenAI transcription, or provider-native realtime input
- LLM: OpenAI, Gemini, Anthropic, or domain-specific hosted model
- TTS: Cartesia Sonic or ElevenLabs
- Orchestration: LiveKit Agents, Pipecat, LangGraph, or custom state machine
- Data: Postgres plus Redis for active session state
- Integrations: calendar, CRM, ticketing, payments, order management, internal APIs

### Production Additions

- Tool schemas with strict validation.
- Confirmation loops for high-risk actions.
- Human handoff and call transfer.
- Prompt/version registry.
- Conversation replay and transcript search.
- Synthetic call tests and real-call evaluation.
- Latency budget dashboards by stage: VAD, STT, LLM first token, TTS first byte, playback.
- Privacy controls: retention policy, redaction, consent notices, role-based access.

## Key Engineering Concerns

### Latency

Voice agents are judged by time-to-first-audio, interruption response, and pause handling. A good pipeline streams at every stage:

- Stream audio into STT or realtime model.
- Start LLM generation on partial/final transcripts when safe.
- Stream LLM tokens into TTS.
- Stream TTS audio chunks to the client.

### Turn Detection

This is one of the hardest parts. VAD alone can interrupt users during thoughtful pauses. LiveKit’s turn detector adds conversational context to VAD so the agent can better decide whether the user is done speaking. Hume also highlights tone-aware end-of-turn detection as a core capability.

### Barge-In

The system must stop playback quickly when the user interrupts, clear buffered audio, and keep conversation state consistent. This is easier with native realtime APIs and harder in a chained pipeline unless cancellation is designed from the start.

### Tool Calling

Tool calls need to be explicit, validated, and observable. In voice, the agent should usually speak while long tools run or tell the user what it is doing. For critical workflows, use structured outputs and repeat confirmations.

### Telephony

Phone calls introduce narrowband audio, codecs, DTMF, carrier behavior, latency, dropped packets, call transfer, and compliance needs. Twilio Media Streams can bridge phone audio to a WebSocket server, but your app still owns audio conversion, stream lifecycle, and integration with the AI stack.

### Evaluation

Voice evaluation should test more than LLM answer quality:

- Did the agent interrupt too early?
- Did it respond too slowly?
- Did it recover from noisy audio?
- Did it confirm critical details?
- Did it call the right tool with the right arguments?
- Did it handle silence, caller frustration, repeated questions, and hangups?

## Build Strategy

### Phase 1: Prototype

Build a browser voice agent first. It is easier than telephony because browser audio can use WebRTC and avoids PSTN codec problems. Use OpenAI Realtime or Gemini Live directly, with one or two tools such as `lookup_customer` and `create_ticket`.

### Phase 2: Controlled Workflow

Add a domain-specific state machine for the core task. Avoid relying on prompt-only behavior for business-critical steps. Add structured tool responses, validation, and transcript logging.

### Phase 3: Telephony

Add Twilio Media Streams or LiveKit SIP. Validate audio conversion, interruption behavior, DTMF handling, call transfer, and hangup events.

### Phase 4: Production Hardening

Add automated call tests, replay tooling, analytics, redaction, escalation rules, monitoring, and cost controls.

## Decision Matrix

| Need | Best Starting Point |
| --- | --- |
| Fast natural browser voice demo | OpenAI Realtime Agents SDK |
| Voice + vision realtime agent | Gemini Live API |
| Full control over pipeline and transport | LiveKit Agents |
| Phone-call automation | Twilio Media Streams + LiveKit/Deepgram/OpenAI/Cartesia |
| Strong managed voice platform | ElevenLabs or Vapi/Retell-style platform |
| Emotional/prosody-aware agent | Hume EVI |
| Best-of-breed TTS/STT components | Cartesia, Deepgram, ElevenLabs |
| Enterprise AWS stack | Amazon Connect/Lex/Transcribe/Polly/Bedrock/Lambda |

## Suggested Initial Choice

For this project, start with this architecture:

**Browser MVP**

```
React/Next.js client
  -> ephemeral token from backend
  -> OpenAI Realtime or LiveKit WebRTC session
  -> agent instructions + tools
  -> backend APIs
  -> Postgres session logs
```

Then add telephony:

```
Twilio phone call
  -> bidirectional Media Stream WebSocket
  -> backend audio bridge
  -> realtime model or STT/LLM/TTS pipeline
  -> Twilio playback
```

This gives you the fastest path to a working product while preserving a path to phone support, provider swaps, and production observability.

## Sources

- OpenAI, Voice agents: https://developers.openai.com/api/docs/guides/voice-agents
- OpenAI, Realtime API docs: https://developers.openai.com/api/docs/guides/realtime
- Google, Gemini Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Google, Live API tool use: https://ai.google.dev/gemini-api/docs/live-api/tools
- LiveKit, Voice AI quickstart: https://docs.livekit.io/agents/start/voice-ai/
- LiveKit, turn detector plugin: https://docs.livekit.io/agents/logic/turns/turn-detector/
- Deepgram, Voice Agent API: https://developers.deepgram.com/docs/voice-agent
- ElevenLabs, ElevenAgents overview: https://elevenlabs.io/docs/eleven-agents/overview
- Twilio, Media Streams overview: https://www.twilio.com/docs/voice/media-streams
- Hume, Speech-to-Speech EVI: https://dev.hume.ai/docs/speech-to-speech-evi/overview
- Cartesia, API overview: https://docs.cartesia.ai/get-started/overview
- AWS, Speech and voice agents pattern: https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/speech-and-voice-agents.html
