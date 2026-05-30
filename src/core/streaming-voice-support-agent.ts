import { SwaramError, toSwaramError } from "./errors.js";
import { InterruptionController } from "./interruption-controller.js";
import { AudioPlaybackQueue } from "./audio-playback-queue.js";
import { TypedEventEmitter } from "./event-emitter.js";
import { ToolRegistry } from "./tool-registry.js";
import { encodeWavFromFloat32 } from "./wav.js";
import type {
  AudioChunk,
  LLMStreamEvent,
  StreamingAgentStatus,
  StreamingVoiceSupportAgentConfig,
  StreamingVoiceSupportAgentEventMap,
  ToolCall,
  TranscriptDelta,
  TranscriptMessage,
  Unsubscribe,
} from "../types.js";

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `swaram_${Date.now()}_${Math.random()}`;
}

function createMessage(role: TranscriptMessage["role"], content: string): TranscriptMessage {
  return {
    id: createId(),
    role,
    content,
    createdAt: new Date(),
  };
}

function createToolCall(name: string, args: Record<string, unknown>, result?: unknown): ToolCall {
  return {
    id: createId(),
    name,
    args,
    result,
    createdAt: new Date(),
  };
}

function hasError(payload: unknown): payload is { error: Error } {
  return Boolean(payload && typeof payload === "object" && "error" in payload);
}

function asTranscriptDelta(payload: TranscriptDelta | { error: Error }) {
  if (hasError(payload)) {
    throw payload.error;
  }

  return payload;
}

export class StreamingVoiceSupportAgent {
  readonly sessionId = createId();
  readonly events = new TypedEventEmitter<StreamingVoiceSupportAgentEventMap>();
  readonly tools: ToolRegistry;
  readonly playback: AudioPlaybackQueue;
  private transcript: TranscriptMessage[] = [];
  private toolCalls: ToolCall[] = [];
  private status: StreamingAgentStatus = "idle";
  private abortController: AbortController | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private finalTranscript = "";
  private readonly instructions: string;
  private readonly interruptionController: InterruptionController;

  constructor(private readonly config: StreamingVoiceSupportAgentConfig) {
    this.instructions = config.instructions ?? config.template?.instructions ?? "";
    this.tools = new ToolRegistry([...(config.template?.tools ?? []), ...(config.tools ?? [])]);
    this.playback = new AudioPlaybackQueue({
      onStart: () => {
        // Keep status on "speaking" for the whole spoken response (not just while
        // the LLM streams text), so barge-in stays armed during playback.
        if (this.status !== "error" && this.status !== "stopped" && this.status !== "interrupted") {
          this.setStatus("speaking");
        }
        this.events.emit("audioStart", {});
      },
      onEnd: () => {
        if (this.status === "speaking") {
          this.setStatus("listening");
        }
        this.events.emit("audioEnd", {});
      },
      onError: (error) => this.fail(error),
    });
    this.interruptionController = new InterruptionController({
      getStatus: () => this.status,
      setInterrupted: (reason) => {
        this.setStatus("interrupted");
        this.events.emit("interruption", { reason });
      },
      llm: config.llm,
      tts: config.tts,
      playback: this.playback,
    });

    if (this.instructions) {
      this.addMessage("system", this.instructions);
    }

    this.bindProviderEvents();
  }

  getStatus() {
    return this.status;
  }

  getTranscript() {
    return [...this.transcript];
  }

  getToolCalls() {
    return [...this.toolCalls];
  }

  on<TEvent extends keyof StreamingVoiceSupportAgentEventMap>(
    event: TEvent,
    handler: (payload: StreamingVoiceSupportAgentEventMap[TEvent]) => void,
  ): Unsubscribe {
    return this.events.on(event, handler);
  }

  async start() {
    if (this.status !== "idle" && this.status !== "stopped" && this.status !== "interrupted" && this.status !== "error") {
      throw this.fail(new SwaramError("CONCURRENT_TURN", "A streaming voice session is already active."));
    }

    this.abortController = new AbortController();
    this.setStatus("listening");

    try {
      await this.config.vad.start({ signal: this.abortController.signal });
      await this.config.stt.connect({
        language: this.config.voice?.language ?? "en-US",
        signal: this.abortController.signal,
      });
      await this.config.tts.connect({
        ...(this.config.voice ? { voice: this.config.voice } : {}),
        signal: this.abortController.signal,
      });
      await this.startMicrophoneStreaming();
    } catch (error) {
      throw this.fail(toSwaramError(error, "PROVIDER_FAILURE"));
    }
  }

  async stop() {
    this.stopProviders();
    await this.playback.close();
    this.setStatus("stopped");
  }

  interrupt() {
    this.interruptionController.interruptManually();
  }

  private bindProviderEvents() {
    this.config.vad.on("speechStart", () => {
      if (this.status === "error" || this.status === "stopped") {
        return;
      }

      const interrupted = this.interruptionController.handleSpeechStart();
      this.events.emit("speechStart", {});
      if (!interrupted) {
        this.setStatus("user_speaking");
      }
    });

    this.config.vad.on("speechEnd", (payload) => {
      if (this.status === "error" || this.status === "stopped") {
        return;
      }

      this.events.emit("speechEnd", {});
      this.setStatus("transcribing");

      if (this.config.sttAudioSource === "vad" && payload?.audio && payload.audio.length > 0) {
        const wav = encodeWavFromFloat32(payload.audio, this.config.vadSampleRate ?? 16000);
        this.config.stt.sendAudio({ data: wav, mimeType: "audio/wav" });
      }

      this.config.stt.flush();
    });

    this.config.vad.on("error", (payload) => {
      if (payload.error) {
        this.fail(payload.error);
      }
    });

    this.config.stt.on("partial", (payload) => {
      if (this.status === "error" || this.status === "stopped") {
        return;
      }

      const delta = asTranscriptDelta(payload);
      this.events.emit("partialTranscript", { text: delta.text });
    });

    this.config.stt.on("final", (payload) => {
      if (this.status === "error" || this.status === "stopped") {
        return;
      }

      const delta = asTranscriptDelta(payload);
      this.finalTranscript = delta.text;
      this.events.emit("finalTranscript", { text: delta.text });
    });

    this.config.stt.on("speechFinal", (payload) => {
      if (this.status === "error" || this.status === "stopped") {
        return;
      }

      const delta = asTranscriptDelta(payload);
      const text = delta.text || this.finalTranscript;
      if (text) {
        void this.respondToFinalTranscript(text);
      }
    });

    this.config.stt.on("error", (payload) => {
      if (hasError(payload)) {
        this.fail(payload.error);
      }
    });

    this.config.tts.on("audio", (payload) => {
      if (hasError(payload)) {
        this.fail(payload.error);
        return;
      }

      this.playback.enqueue(payload as AudioChunk);
    });

    this.config.tts.on("error", (payload) => {
      if (hasError(payload)) {
        this.fail(payload.error);
      }
    });
  }

  private async startMicrophoneStreaming() {
    // In "vad" mode the STT is fed a standalone WAV per utterance from the VAD's
    // PCM (see the speechEnd handler), so the continuous MediaRecorder is skipped.
    if (this.config.sttAudioSource === "vad") {
      return;
    }

    if (typeof navigator === "undefined" || typeof MediaRecorder === "undefined") {
      return;
    }

    this.mediaStream = this.config.mediaStream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
    const recorderOptions = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? { mimeType: "audio/webm;codecs=opus" }
      : undefined;
    this.mediaRecorder = new MediaRecorder(this.mediaStream, recorderOptions);

    this.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        this.config.stt.sendAudio({ data: event.data, mimeType: event.data.type });
      }
    });
    this.mediaRecorder.start(100);
  }

  private async respondToFinalTranscript(text: string) {
    if (this.status === "error" || this.status === "stopped") {
      return;
    }

    if (!text.trim()) {
      return;
    }

    this.addMessage("user", text);
    this.setStatus("thinking");

    let assistantText = "";
    let textBuffer = "";

    try {
      for await (const event of this.config.llm.stream(
        {
          input: text,
          transcript: this.getTranscript(),
          instructions: this.instructions,
          toolCalls: this.getToolCalls(),
        },
        {
          ...(this.abortController?.signal ? { signal: this.abortController.signal } : {}),
        },
      )) {
        await this.handleLLMEvent(event);

        if (event.type === "text") {
          assistantText += event.text;
          textBuffer += event.text;
          this.events.emit("llmToken", { text: event.text });

          if (this.status !== "speaking") {
            this.setStatus("speaking");
          }

          if (/[.!?]["')\]]?\s*$/.test(textBuffer) || textBuffer.length >= 80) {
            this.config.tts.sendText(textBuffer);
            textBuffer = "";
          }
        }
      }

      if (textBuffer) {
        this.config.tts.sendText(textBuffer);
      }

      this.config.tts.flush();
      if (assistantText) {
        this.addMessage("assistant", assistantText);
      }
      // Don't force "listening" here — audio is still synthesizing/playing.
      // Playback's onEnd moves us back to "listening". Only do it now if there's
      // no audio coming (e.g. an empty or tool-only response).
      if (!assistantText && !this.playback.isActive()) {
        this.setStatus("listening");
      }
    } catch (error) {
      // A barge-in aborts the in-flight LLM stream on purpose; that surfaces here
      // as an abort. It's expected, not a failure, so don't tear the session down.
      if (this.status === "interrupted" || (error instanceof Error && error.name === "AbortError")) {
        return;
      }
      this.fail(toSwaramError(error, "PROVIDER_FAILURE"));
    }
  }

  private async handleLLMEvent(event: LLMStreamEvent) {
    if (event.type !== "toolCall") {
      return;
    }

    const result = await this.tools.run(event.name, event.args, {
      sessionId: this.sessionId,
      transcript: this.getTranscript(),
      instructions: this.instructions,
    });
    const completedCall = createToolCall(event.name, event.args, result);
    this.toolCalls.push(completedCall);
    this.events.emit("toolCall", { toolCall: completedCall });
  }

  private addMessage(role: TranscriptMessage["role"], content: string) {
    const message = createMessage(role, content);
    this.transcript.push(message);
    this.events.emit("transcript", {
      message,
      transcript: this.getTranscript(),
    });
    return message;
  }

  private setStatus(status: StreamingAgentStatus) {
    this.status = status;
    this.events.emit("status", { status });
  }

  private stopProviders() {
    this.abortController?.abort();

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.config.vad.stop();
    this.config.stt.close();
    this.config.tts.stop();
    this.config.tts.close();
    this.abortController = null;
    this.mediaRecorder = null;
    this.mediaStream = null;
  }

  private fail(error: unknown) {
    const normalized = toSwaramError(error, "PROVIDER_FAILURE");
    this.stopProviders();
    void this.playback.close();
    this.setStatus("error");
    this.events.emit("error", { error: normalized });
    return normalized;
  }
}
