import { connectFetch, throwForStatus } from "../../core/http.js";
import type { LLMStreamEvent, LLMStreamInput, StreamingLLMProvider } from "../../types.js";
import { buildChatMessages, buildChatTools } from "./chat-messages.js";
import { ToolJsonStreamSplitter, buildToolJsonSystemPrompt } from "./tool-json-stream.js";

type OllamaStreamChunk = {
  message?: {
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
  response?: string;
  done?: boolean;
};

export class OllamaStreamingLLMProvider implements StreamingLLMProvider {
  readonly name = "ollama-streaming-llm";
  private abortController: AbortController | null = null;

  constructor(
    private readonly options: {
      baseUrl?: string;
      endpoint?: string;
      model?: string;
      fetchImpl?: typeof fetch;
      systemPrompt?: string;
      timeoutMs?: number;
      maxRetries?: number;
    } = {},
  ) {}

  async *stream(input: LLMStreamInput, options: { signal?: AbortSignal } = {}): AsyncIterable<LLMStreamEvent> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    options.signal?.addEventListener("abort", () => this.abort(), { once: true });

    const tools = buildChatTools(input.tools);
    const systemPrompt = this.options.systemPrompt ?? (tools ? input.instructions : buildToolJsonSystemPrompt(input.instructions));

    const response = await connectFetch(
      this.url(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model ?? "llama3.1:8b",
          stream: true,
          messages: buildChatMessages(input, systemPrompt),
          ...(tools ? { tools } : {}),
        }),
      },
      {
        signal,
        fetchImpl: this.options.fetchImpl,
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.maxRetries !== undefined ? { maxRetries: this.options.maxRetries } : {}),
      },
    );

    await throwForStatus(response, "Ollama request");

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const splitter = new ToolJsonStreamSplitter();

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
        if (!trimmed) {
          continue;
        }

        let chunk: OllamaStreamChunk;
        try {
          chunk = JSON.parse(trimmed) as OllamaStreamChunk;
        } catch {
          continue;
        }

        for (const toolCall of chunk.message?.tool_calls ?? []) {
          const name = toolCall.function?.name;
          if (name) {
            yield { type: "toolCall", name, args: toolCall.function?.arguments ?? {} };
          }
        }

        const text = chunk.message?.content ?? chunk.response ?? "";
        if (text) {
          const safe = splitter.push(text);
          if (safe) {
            yield { type: "text", text: safe };
          }
        }
      }
    }

    const tail = splitter.flush();
    if (tail.text) {
      yield { type: "text", text: tail.text };
    }
    for (const call of tail.toolCalls) {
      yield { type: "toolCall", name: call.name, args: call.args };
    }
    yield { type: "done" };
  }

  abort() {
    this.abortController?.abort();
    this.abortController = null;
  }

  private url() {
    const baseUrl = this.options.baseUrl ?? "http://localhost:11434";
    return new URL(this.options.endpoint ?? "/api/chat", baseUrl).toString();
  }
}
