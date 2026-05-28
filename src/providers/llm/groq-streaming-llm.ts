import type { LLMStreamEvent, LLMStreamInput, StreamingLLMProvider } from "../../types.js";
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
  private abortController: AbortController | null = null;

  constructor(
    private readonly options: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
      endpoint?: string;
      fetchImpl?: typeof fetch;
      systemPrompt?: string;
      temperature?: number;
    },
  ) {}

  async *stream(input: LLMStreamInput, options: { signal?: AbortSignal } = {}): AsyncIterable<LLMStreamEvent> {
    if (!this.options.apiKey) {
      throw new Error("GroqStreamingLLMProvider requires an apiKey. Enter your Groq API key in the playground.");
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    options.signal?.addEventListener("abort", () => this.abort(), { once: true });

    const response = await (this.options.fetchImpl ?? fetch)(this.url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model ?? "llama-3.1-8b-instant",
        stream: true,
        temperature: this.options.temperature ?? 0.5,
        messages: [
          {
            role: "system",
            content: this.options.systemPrompt ?? buildToolJsonSystemPrompt(input.instructions),
          },
          ...input.transcript
            .filter((message) => message.role !== "system")
            .map((message) => ({ role: message.role, content: message.content })),
          { role: "user", content: input.input },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Groq request failed with status ${response.status}. ${detail}`.trim());
    }

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
