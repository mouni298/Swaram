import { toSwaramError } from "./errors.js";
import { TypedEventEmitter } from "./event-emitter.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  LLMStreamEvent,
  StreamingLLMProvider,
  SupportTemplate,
  ToolCall,
  ToolDefinition,
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

export type TextVoiceAgentConfig = {
  instructions?: string;
  template?: SupportTemplate;
  llm: StreamingLLMProvider;
  tools?: ToolDefinition[];
};

export type TextVoiceAgentEventMap = {
  /** A chunk of human-facing assistant text (tool JSON is never emitted here). */
  token: { text: string };
  /** A committed transcript message (user or assistant). */
  transcript: { message: TranscriptMessage; transcript: TranscriptMessage[] };
  /** A tool finished running. */
  toolCall: { toolCall: ToolCall };
  /** The assistant turn finished; `text` is the full assistant reply. */
  turnEnd: { text: string };
  error: { error: Error };
};

/**
 * Headless, transport-agnostic turn engine: takes a user prompt as text, streams
 * an LLM reply, runs tools, and maintains the transcript — with no STT, TTS, VAD,
 * or audio playback. This is the orchestration core a text-based transport (e.g.
 * Twilio ConversationRelay, which does STT/TTS itself) plugs into, and the part of
 * the streaming agent that is portable to Node.
 *
 * Mirrors StreamingVoiceSupportAgent's `respondToFinalTranscript` LLM/tool path so
 * the spoken and phone agents behave identically; it just emits text tokens
 * instead of pushing audio.
 */
export class TextVoiceAgent {
  readonly sessionId = createId();
  readonly events = new TypedEventEmitter<TextVoiceAgentEventMap>();
  readonly tools: ToolRegistry;
  private transcript: TranscriptMessage[] = [];
  private toolCalls: ToolCall[] = [];
  private readonly instructions: string;
  private abortController: AbortController | null = null;
  private responding = false;

  constructor(private readonly config: TextVoiceAgentConfig) {
    this.instructions = config.instructions ?? config.template?.instructions ?? "";
    this.tools = new ToolRegistry([...(config.template?.tools ?? []), ...(config.tools ?? [])]);

    if (this.instructions) {
      this.transcript.push(createMessage("system", this.instructions));
    }
  }

  getTranscript() {
    return [...this.transcript];
  }

  getToolCalls() {
    return [...this.toolCalls];
  }

  isResponding() {
    return this.responding;
  }

  on<TEvent extends keyof TextVoiceAgentEventMap>(
    event: TEvent,
    handler: (payload: TextVoiceAgentEventMap[TEvent]) => void,
  ): Unsubscribe {
    return this.events.on(event, handler);
  }

  /** Abort the in-flight reply (e.g. the caller barged in). Safe to call anytime. */
  interrupt() {
    this.abortController?.abort();
  }

  /**
   * Run one user turn: stream the assistant reply, executing tools as they appear.
   * Emits `token` per human-facing text chunk and `turnEnd` with the full reply.
   * Resolves with the assistant text (empty string for a tool-only / aborted turn).
   */
  async handlePrompt(text: string): Promise<string> {
    if (!text.trim()) {
      return "";
    }

    // A new prompt while still replying means a barge-in: drop the old turn.
    if (this.responding) {
      this.interrupt();
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.responding = true;
    this.addMessage("user", text);

    let assistantText = "";

    try {
      for await (const event of this.config.llm.stream(
        {
          input: text,
          transcript: this.getTranscript(),
          instructions: this.instructions,
          toolCalls: this.getToolCalls(),
        },
        { signal },
      )) {
        if (signal.aborted) {
          break;
        }

        await this.handleLLMEvent(event);

        if (event.type === "text") {
          assistantText += event.text;
          this.events.emit("token", { text: event.text });
        }
      }

      if (assistantText) {
        this.addMessage("assistant", assistantText);
      }
      this.events.emit("turnEnd", { text: assistantText });
      return assistantText;
    } catch (error) {
      // A barge-in aborts the in-flight stream on purpose; surface as an abort and
      // don't treat it as a failure.
      if (error instanceof Error && error.name === "AbortError") {
        return assistantText;
      }
      const normalized = toSwaramError(error, "PROVIDER_FAILURE");
      this.events.emit("error", { error: normalized });
      throw normalized;
    } finally {
      this.responding = false;
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
}
