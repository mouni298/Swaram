import { SwaramError } from "../../core/errors.js";
import { readEnv } from "../../core/env.js";
import { connectFetch, throwForStatus } from "../../core/http.js";
import { toolResultText } from "../../core/session.js";
import type { LLMStreamEvent, LLMStreamInput, StreamingLLMProvider, TranscriptMessage } from "../../types.js";

type AnthropicMessage = { role: "user" | "assistant"; content: string };

type StreamEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; name?: string; id?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
};

/**
 * Streaming provider for the Anthropic Messages API, with native tool use and
 * prompt caching on the system instructions. Groq remains the default LLM; this
 * is offered as a high-quality option. Reads ANTHROPIC_API_KEY when no apiKey is
 * passed.
 */
export class AnthropicStreamingLLMProvider implements StreamingLLMProvider {
  readonly name = "anthropic-streaming-llm";
  private readonly apiKey: string;
  private abortController: AbortController | null = null;

  constructor(
    private readonly options: {
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      maxTokens?: number;
      version?: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      maxRetries?: number;
    } = {},
  ) {
    this.apiKey = options.apiKey ?? readEnv("ANTHROPIC_API_KEY") ?? "";
  }

  isSupported() {
    return Boolean(this.apiKey);
  }

  async *stream(input: LLMStreamInput, options: { signal?: AbortSignal } = {}): AsyncIterable<LLMStreamEvent> {
    if (!this.apiKey) {
      throw new SwaramError("AUTH", "AnthropicStreamingLLMProvider requires an apiKey (or set ANTHROPIC_API_KEY).");
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    options.signal?.addEventListener("abort", () => this.abort(), { once: true });

    const tools = input.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));

    const body: Record<string, unknown> = {
      model: this.options.model ?? "claude-haiku-4-5-20251001",
      max_tokens: this.options.maxTokens ?? 1024,
      stream: true,
      // Cache the (usually long, static) system instructions across turns.
      system: input.instructions
        ? [{ type: "text", text: input.instructions, cache_control: { type: "ephemeral" } }]
        : undefined,
      messages: this.buildMessages(input),
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const response = await connectFetch(
      this.url(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.options.version ?? "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      {
        signal,
        fetchImpl: this.options.fetchImpl,
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.maxRetries !== undefined ? { maxRetries: this.options.maxRetries } : {}),
      },
    );

    await throwForStatus(response, "Anthropic request");

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Per content-block index: a tool_use block accumulating its input JSON.
    const toolBlocks = new Map<number, { name: string; argsText: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payload = trimmed.slice(5).trim();
        if (!payload) {
          continue;
        }

        let event: StreamEvent;
        try {
          event = JSON.parse(payload) as StreamEvent;
        } catch {
          continue;
        }

        const index = event.index ?? 0;

        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolBlocks.set(index, { name: event.content_block.name ?? "", argsText: "" });
          continue;
        }

        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text) {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta") {
            const slot = toolBlocks.get(index);
            if (slot) {
              slot.argsText += event.delta.partial_json ?? "";
            }
          }
          continue;
        }

        if (event.type === "content_block_stop") {
          const slot = toolBlocks.get(index);
          if (slot?.name) {
            yield { type: "toolCall", name: slot.name, args: this.parseArgs(slot.argsText) };
            toolBlocks.delete(index);
          }
        }
      }
    }

    yield { type: "done" };
  }

  abort() {
    this.abortController?.abort();
    this.abortController = null;
  }

  private parseArgs(argsText: string): Record<string, unknown> {
    if (!argsText) {
      return {};
    }
    try {
      return JSON.parse(argsText) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private buildMessages(input: LLMStreamInput): AnthropicMessage[] {
    const history = input.transcript.filter((message) => message.role !== "system");
    const messages = history.map((message) => this.serialize(message));

    if (!history.some((message) => message.role === "user") && input.input) {
      messages.push({ role: "user", content: input.input });
    }

    return messages;
  }

  private serialize(message: TranscriptMessage): AnthropicMessage {
    if (message.role === "assistant") {
      return { role: "assistant", content: message.content };
    }
    if (message.role === "tool") {
      return { role: "user", content: toolResultText(message.name, message.content) };
    }
    return { role: "user", content: message.content };
  }

  private url() {
    const baseUrl = this.options.baseUrl ?? "https://api.anthropic.com";
    return new URL("/v1/messages", baseUrl).toString();
  }
}
