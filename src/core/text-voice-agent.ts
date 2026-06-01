import { toSwaramError } from "./errors.js";
import { TypedEventEmitter } from "./event-emitter.js";
import { ToolRegistry } from "./tool-registry.js";
import { MAX_TOOL_ROUNDS, createId, createMessage, createToolCall, latestUserText } from "./session.js";
import type {
  PlannedToolCall,
  StreamingLLMProvider,
  SupportTemplate,
  ToolCall,
  ToolDefinition,
  TranscriptMessage,
  Unsubscribe,
} from "../types.js";

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
 * an LLM reply, runs tools (feeding results back for a grounded follow-up), and
 * maintains the transcript — with no STT, TTS, VAD, or audio playback. This is the
 * orchestration core a text-based transport (e.g. Twilio ConversationRelay, which
 * does STT/TTS itself) plugs into, and the part of the streaming agent that is
 * portable to Node.
 *
 * Mirrors StreamingVoiceSupportAgent's tool loop so the spoken and phone agents
 * behave identically; it just emits text tokens instead of pushing audio.
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
   * Run one user turn: stream the assistant reply, executing tools as they appear
   * and re-prompting with their results. Emits `token` per human-facing text chunk
   * and `turnEnd` with the full reply. Resolves with the assistant text (empty
   * string for a tool-only / aborted turn).
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

    let fullText = "";

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        if (signal.aborted) {
          break;
        }

        const { text: roundText, toolCalls } = await this.streamRound(signal);
        fullText += roundText;

        // On a barge-in we drop the half-formed turn without committing it.
        if (signal.aborted) {
          break;
        }

        if (roundText) {
          this.addMessage("assistant", roundText);
        }

        if (toolCalls.length === 0) {
          break;
        }

        await this.runToolCalls(toolCalls);
      }

      this.events.emit("turnEnd", { text: fullText });
      return fullText;
    } catch (error) {
      // A barge-in aborts the in-flight stream on purpose; surface as an abort and
      // don't treat it as a failure.
      if (error instanceof Error && error.name === "AbortError") {
        return fullText;
      }
      const normalized = toSwaramError(error, "PROVIDER_FAILURE");
      this.events.emit("error", { error: normalized });
      throw normalized;
    } finally {
      this.responding = false;
    }
  }

  private async streamRound(signal: AbortSignal): Promise<{ text: string; toolCalls: PlannedToolCall[] }> {
    let roundText = "";
    const toolCalls: PlannedToolCall[] = [];
    const toolSchemas = this.tools.schemas();

    try {
      for await (const event of this.config.llm.stream(
        {
          // See StreamingVoiceSupportAgent.streamRound: `transcript` is the source
          // of truth, but raw-passthrough providers rely on `input`.
          input: latestUserText(this.transcript),
          transcript: this.getTranscript(),
          instructions: this.instructions,
          toolCalls: this.getToolCalls(),
          ...(toolSchemas ? { tools: toolSchemas } : {}),
        },
        { signal },
      )) {
        if (signal.aborted) {
          break;
        }

        if (event.type === "toolCall") {
          toolCalls.push({ name: event.name, args: event.args });
        } else if (event.type === "text") {
          roundText += event.text;
          this.events.emit("token", { text: event.text });
        }
      }
    } catch (error) {
      // A barge-in aborts the in-flight stream on purpose — keep the partial text
      // gathered so far and let the caller settle the turn. Re-throw real errors.
      if (!(signal.aborted || (error instanceof Error && error.name === "AbortError"))) {
        throw error;
      }
    }

    return { text: roundText, toolCalls };
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
}
