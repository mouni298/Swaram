import { SwaramError, toSwaramError } from "./errors.js";
import { InterruptionController } from "./interruption-controller.js";
import { AudioPlaybackQueue } from "./audio-playback-queue.js";
import { TypedEventEmitter } from "./event-emitter.js";
import { ToolRegistry } from "./tool-registry.js";
import { MAX_TOOL_ROUNDS, createId, createMessage, createToolCall, latestUserText } from "./session.js";
import { encodeWavFromFloat32 } from "./wav.js";
import type {
  AudioChunk,
  PlannedToolCall,
  StreamingAgentStatus,
  StreamingVoiceSupportAgentConfig,
  StreamingVoiceSupportAgentEventMap,
  TranscriptDelta,
  TranscriptMessage,
  Unsubscribe,
} from "../types.js";

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
  private toolCalls: ReturnType<typeof createToolCall>[] = [];
  private status: StreamingAgentStatus = "idle";
  private abortController: AbortController | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private finalTranscript = "";
  // True while a live mic session is running (start()..stop()). Lets typed turns
  // sent via sendText() return to "idle" instead of "listening" when no mic is on.
  private sessionActive = false;
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
          // Back to listening while a mic session is live; otherwise (a typed
          // turn with no mic) settle on idle so the UI doesn't imply it's hearing.
          this.setStatus(this.sessionActive ? "listening" : "idle");
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

    this.assertProvidersSupported();

    this.abortController = new AbortController();
    this.sessionActive = true;
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
    this.sessionActive = false;
    this.stopProviders();
    await this.playback.close();
    this.setStatus("stopped");
  }

  interrupt() {
    this.interruptionController.interruptManually();
  }

  /**
   * Send a typed message as a user turn. Works with or without a live mic
   * session: if none is running it lazily connects the TTS so the reply is still
   * spoken, then runs the normal LLM -> TTS path. Lets a text box (or any
   * non-voice UI) drive the agent.
   */
  async sendText(text: string) {
    if (!text.trim()) {
      return;
    }

    // Outside a live session there's no abort controller or connected TTS yet,
    // and the status guard in respondToFinalTranscript would reject a "stopped"/
    // "error" state. Set up a fresh turn so the response can stream and be spoken.
    if (!this.sessionActive) {
      this.abortController = new AbortController();
      this.setStatus("thinking");
      try {
        await this.config.tts.connect({
          ...(this.config.voice ? { voice: this.config.voice } : {}),
          signal: this.abortController.signal,
        });
      } catch (error) {
        throw this.fail(toSwaramError(error, "PROVIDER_FAILURE"));
      }
    }

    await this.respondToFinalTranscript(text);
  }

  private assertProvidersSupported() {
    if (this.config.stt.isSupported?.() === false) {
      throw this.fail(new SwaramError("STT_UNSUPPORTED", `STT provider "${this.config.stt.name}" is not supported.`));
    }
    if (this.config.llm.isSupported?.() === false) {
      throw this.fail(new SwaramError("LLM_UNSUPPORTED", `LLM provider "${this.config.llm.name}" is not supported.`));
    }
    if (this.config.tts.isSupported?.() === false) {
      throw this.fail(new SwaramError("TTS_UNSUPPORTED", `TTS provider "${this.config.tts.name}" is not supported.`));
    }
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

    try {
      let spokeAnything = false;

      // Tool loop: stream a reply; if the model called tools, run them, feed the
      // results back into the transcript, and re-prompt so the spoken answer is
      // grounded in those results. Repeat until a round makes no tool calls.
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const { text: roundText, toolCalls } = await this.streamRound();

        if (roundText) {
          spokeAnything = true;
          this.addMessage("assistant", roundText);
        }

        if (toolCalls.length === 0) {
          break;
        }

        await this.runToolCalls(toolCalls);
      }

      this.config.tts.flush();

      // Don't force "listening" if audio is still synthesizing/playing — playback's
      // onEnd handles that. Only settle now for an empty / tool-only response.
      if (!spokeAnything && !this.playback.isActive()) {
        this.setStatus(this.sessionActive ? "listening" : "idle");
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

  /** Stream one LLM response, speaking text as it arrives. Returns text + tool calls. */
  private async streamRound(): Promise<{ text: string; toolCalls: PlannedToolCall[] }> {
    let assistantText = "";
    let textBuffer = "";
    const toolCalls: PlannedToolCall[] = [];
    const toolSchemas = this.tools.schemas();

    for await (const event of this.config.llm.stream(
      {
        // The latest user turn. SDK providers build messages from `transcript`
        // (and de-dupe this), but a raw passthrough like HttpBridgeLLMProvider
        // relies on `input` carrying the question.
        input: latestUserText(this.transcript),
        transcript: this.getTranscript(),
        instructions: this.instructions,
        toolCalls: this.getToolCalls(),
        ...(toolSchemas ? { tools: toolSchemas } : {}),
      },
      {
        ...(this.abortController?.signal ? { signal: this.abortController.signal } : {}),
      },
    )) {
      if (event.type === "toolCall") {
        toolCalls.push({ name: event.name, args: event.args });
        continue;
      }

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

    return { text: assistantText, toolCalls };
  }

  private async runToolCalls(plannedCalls: PlannedToolCall[]) {
    for (const planned of plannedCalls) {
      const result = await this.tools.run(planned.name, planned.args, {
        sessionId: this.sessionId,
        transcript: this.getTranscript(),
        instructions: this.instructions,
      });
      const completedCall = createToolCall(planned.name, planned.args, result);
      this.toolCalls.push(completedCall);
      this.events.emit("toolCall", { toolCall: completedCall });
      // Feed the result back so the next round's reply is grounded in it.
      this.addMessage("tool", JSON.stringify(result ?? null), planned.name);
    }
  }

  private addMessage(role: TranscriptMessage["role"], content: string, name?: string) {
    const message = createMessage(role, content, name);
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
    this.sessionActive = false;
    this.stopProviders();
    void this.playback.close();
    this.setStatus("error");
    this.events.emit("error", { error: normalized });
    return normalized;
  }
}
