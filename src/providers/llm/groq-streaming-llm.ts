import { SwaramError } from "../../core/errors.js";
import { readEnv } from "../../core/env.js";
import { connectFetch, throwForStatus } from "../../core/http.js";
import type { LLMStreamEvent, LLMStreamInput, StreamingLLMProvider } from "../../types.js";
import { buildChatMessages, buildChatTools } from "./chat-messages.js";
import { ToolJsonStreamSplitter, buildToolJsonSystemPrompt } from "./tool-json-stream.js";

type GroqDelta = {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
};

type GroqStreamChunk = {
  choices?: Array<{
    delta?: GroqDelta;
    finish_reason?: string | null;
  }>;
};

export class GroqStreamingLLMProvider implements StreamingLLMProvider {
  readonly name = "groq-streaming-llm";
  private readonly apiKey: string;
  private abortController: AbortController | null = null;

  constructor(
    private readonly options: {
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      endpoint?: string;
      fetchImpl?: typeof fetch;
      systemPrompt?: string;
      temperature?: number;
      timeoutMs?: number;
      maxRetries?: number;
    } = {},
  ) {
    this.apiKey = options.apiKey ?? readEnv("GROQ_API_KEY") ?? "";
  }

  isSupported() {
    return Boolean(this.apiKey);
  }

  async *stream(input: LLMStreamInput, options: { signal?: AbortSignal } = {}): AsyncIterable<LLMStreamEvent> {
    if (!this.apiKey) {
      throw new SwaramError("AUTH", "GroqStreamingLLMProvider requires an apiKey (or set GROQ_API_KEY).");
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    options.signal?.addEventListener("abort", () => this.abort(), { once: true });

    const tools = buildChatTools(input.tools);
    // With native tools advertised, let the model use real function calling and
    // keep the system prompt to just the instructions. Without tools, fall back
    // to the prompt-based JSON convention parsed by ToolJsonStreamSplitter.
    const systemPrompt = this.options.systemPrompt ?? (tools ? input.instructions : buildToolJsonSystemPrompt(input.instructions));

    const response = await connectFetch(
      this.url(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model ?? "llama-3.1-8b-instant",
          stream: true,
          temperature: this.options.temperature ?? 0.5,
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

    await throwForStatus(response, "Groq request");

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const splitter = new ToolJsonStreamSplitter();
    const toolAccum = new Map<number, { name: string; argsText: string }>();

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
        if (!payload || payload === "[DONE]") {
          continue;
        }

        let chunk: GroqStreamChunk;
        try {
          chunk = JSON.parse(payload) as GroqStreamChunk;
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }

        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = toolAccum.get(idx) ?? { name: "", argsText: "" };
          if (tc.function?.name) {
            slot.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            slot.argsText += tc.function.arguments;
          }
          toolAccum.set(idx, slot);
        }

        if (delta.content) {
          const safe = splitter.push(delta.content);
          if (safe) {
            yield { type: "text", text: safe };
          }
        }
      }
    }

    for (const { name, argsText } of toolAccum.values()) {
      if (!name) {
        continue;
      }
      let args: Record<string, unknown> = {};
      if (argsText) {
        try {
          args = JSON.parse(argsText) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      yield { type: "toolCall", name, args };
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
    const baseUrl = this.options.baseUrl ?? "https://api.groq.com";
    return new URL(this.options.endpoint ?? "/openai/v1/chat/completions", baseUrl).toString();
  }
}
