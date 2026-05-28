import type { LLMStreamEvent, LLMStreamInput, StreamingLLMProvider } from "../../types.js";

type BridgeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; args?: Record<string, unknown> }
  | { type: "done"; text?: string; intent?: string };

export class OpenAIStreamingLLMProvider implements StreamingLLMProvider {
  readonly name = "openai-streaming-llm";
  private abortController: AbortController | null = null;

  constructor(
    private readonly options: {
      bridgeUrl: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async *stream(input: LLMStreamInput, options: { signal?: AbortSignal } = {}): AsyncIterable<LLMStreamEvent> {
    this.abortController = new AbortController();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const signal = this.abortController.signal;

    options.signal?.addEventListener(
      "abort",
      () => {
        this.abort();
      },
      { once: true },
    );

    const response = await fetchImpl(this.options.bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI bridge failed with status ${response.status}.`);
    }

    if (!response.body) {
      const event = (await response.json()) as BridgeEvent;
      yield this.mapEvent(event);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = this.parseEvent(line);
        if (event) {
          yield this.mapEvent(event);
        }
      }
    }

    const tail = this.parseEvent(buffer);
    if (tail) {
      yield this.mapEvent(tail);
    }
  }

  abort() {
    this.abortController?.abort();
    this.abortController = null;
  }

  private parseEvent(line: string): BridgeEvent | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as BridgeEvent;
    } catch {
      return null;
    }
  }

  private mapEvent(event: BridgeEvent): LLMStreamEvent {
    if (event.type === "text_delta") {
      return { type: "text", text: event.text };
    }

    if (event.type === "tool_call") {
      return { type: "toolCall", name: event.name, args: event.args ?? {} };
    }

    return {
      type: "done",
      ...(event.text ? { text: event.text } : {}),
      ...(event.intent ? { intent: event.intent } : {}),
    };
  }
}
