import { SwaramError, toSwaramError } from "./errors.js";
import { TypedEventEmitter } from "./event-emitter.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  AgentStatus,
  SupportAgentConfig,
  ToolCall,
  TranscriptMessage,
  TurnResult,
  Unsubscribe,
  VoiceSupportAgentEventMap,
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

export class VoiceSupportAgent {
  readonly sessionId = createId();
  readonly events = new TypedEventEmitter<VoiceSupportAgentEventMap>();
  readonly tools: ToolRegistry;
  private transcript: TranscriptMessage[] = [];
  private toolCalls: ToolCall[] = [];
  private status: AgentStatus = "idle";
  private abortController: AbortController | null = null;
  private activeTurn: Promise<TurnResult> | null = null;
  private readonly instructions: string;

  constructor(private readonly config: SupportAgentConfig) {
    this.instructions = config.instructions ?? config.template?.instructions ?? "";
    this.tools = new ToolRegistry([...(config.template?.tools ?? []), ...(config.tools ?? [])]);

    if (this.instructions) {
      this.addMessage("system", this.instructions);
    }
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

  on<TEvent extends keyof VoiceSupportAgentEventMap>(
    event: TEvent,
    handler: (payload: VoiceSupportAgentEventMap[TEvent]) => void,
  ): Unsubscribe {
    return this.events.on(event, handler);
  }

  startTurn() {
    if (this.activeTurn) {
      throw this.fail(new SwaramError("CONCURRENT_TURN", "A voice turn is already active."));
    }

    if (!this.config.stt.isSupported()) {
      throw this.fail(new SwaramError("STT_UNSUPPORTED", `STT provider "${this.config.stt.name}" is not supported.`));
    }

    this.abortController = new AbortController();
    this.setStatus("listening");

    this.activeTurn = this.config.stt
      .listen({
        language: this.config.voice?.language ?? "en-US",
        signal: this.abortController.signal,
      })
      .then((input) => this.sendText(input))
      .catch((error: unknown) => {
        throw this.fail(toSwaramError(error, "PROVIDER_FAILURE"));
      })
      .finally(() => {
        this.activeTurn = null;
      });

    return this.activeTurn;
  }

  stop() {
    this.abortController?.abort();
    this.config.tts.stop?.();
    this.abortController = null;
    this.activeTurn = null;
    this.setStatus("stopped");
  }

  async sendText(input: string): Promise<TurnResult> {
    const cleanInput = input.trim();
    if (!cleanInput) {
      throw this.fail(new SwaramError("EMPTY_INPUT", "Input text is required."));
    }

    this.addMessage("user", cleanInput);
    this.setStatus("thinking");

    try {
      const modelOutput = await this.config.llm.generate({
        input: cleanInput,
        transcript: this.getTranscript(),
        instructions: this.instructions,
        toolCalls: this.getToolCalls(),
      });

      const executedThisTurn: ToolCall[] = [];

      for (const plannedCall of modelOutput.toolCalls ?? []) {
        const result = await this.tools.run(plannedCall.name, plannedCall.args, {
          sessionId: this.sessionId,
          transcript: this.getTranscript(),
          instructions: this.instructions,
        });
        const completedCall = createToolCall(plannedCall.name, plannedCall.args, result);
        this.toolCalls.push(completedCall);
        executedThisTurn.push(completedCall);
        this.events.emit("toolCall", { toolCall: completedCall });
      }

      const assistantMessage = this.addMessage("assistant", modelOutput.text);

      if (!this.config.tts.isSupported()) {
        throw new SwaramError("TTS_UNSUPPORTED", `TTS provider "${this.config.tts.name}" is not supported.`);
      }

      this.setStatus("speaking");
      await this.config.tts.speak(modelOutput.text, {
        ...(this.config.voice ? { voice: this.config.voice } : {}),
        ...(this.abortController?.signal ? { signal: this.abortController.signal } : {}),
      });

      this.setStatus("idle");
      const result: TurnResult = {
        message: assistantMessage,
        toolCalls: executedThisTurn,
      };

      if (modelOutput.intent) {
        result.intent = modelOutput.intent;
      }

      return {
        ...result,
      };
    } catch (error) {
      throw this.fail(toSwaramError(error, "PROVIDER_FAILURE"));
    }
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

  private setStatus(status: AgentStatus) {
    this.status = status;
    this.events.emit("status", { status });
  }

  private fail(error: unknown) {
    const normalized = toSwaramError(error, "PROVIDER_FAILURE");
    this.setStatus("error");
    this.events.emit("error", { error: normalized });
    return normalized;
  }
}

export { VoiceSupportAgent as VoiceAgent };
