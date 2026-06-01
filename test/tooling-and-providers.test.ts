import { describe, expect, it, vi } from "vitest";
import {
  AnthropicStreamingLLMProvider,
  GroqStreamingLLMProvider,
  SwaramError,
} from "../src/index.js";
import { buildChatMessages, buildChatTools } from "../src/providers/llm/chat-messages.js";
import { ToolJsonStreamSplitter } from "../src/providers/llm/tool-json-stream.js";
import type { LLMStreamInput, TranscriptMessage } from "../src/index.js";

function message(role: TranscriptMessage["role"], content: string, name?: string): TranscriptMessage {
  return { id: `${role}-${content}`, role, content, createdAt: new Date(0), ...(name ? { name } : {}) };
}

function streamResponse(lines: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    }),
    { status },
  );
}

describe("buildChatMessages", () => {
  it("does not duplicate the latest user message", () => {
    const input: LLMStreamInput = {
      input: "Where is my order?",
      instructions: "Be brief.",
      toolCalls: [],
      transcript: [
        message("system", "Be brief."),
        message("user", "Where is my order?"),
      ],
    };

    const messages = buildChatMessages(input, "Be brief.");

    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Where is my order?" },
    ]);
  });

  it("falls back to `input` only when there is no conversational history", () => {
    const messages = buildChatMessages(
      { input: "hi", instructions: "x", toolCalls: [], transcript: [message("system", "x")] },
      "x",
    );
    expect(messages).toEqual([
      { role: "system", content: "x" },
      { role: "user", content: "hi" },
    ]);
  });

  it("surfaces tool-result turns to the model as context", () => {
    const messages = buildChatMessages(
      {
        input: "",
        instructions: "x",
        toolCalls: [],
        transcript: [
          message("user", "track 12345"),
          message("tool", '{"status":"shipped"}', "lookup_order"),
        ],
      },
      "x",
    );

    expect(messages.at(-1)).toEqual({
      role: "system",
      content: 'Tool result (lookup_order): {"status":"shipped"}',
    });
  });
});

describe("buildChatTools", () => {
  it("maps SDK tool schemas to OpenAI-style function tools", () => {
    const tools = buildChatTools([
      { name: "lookup_order", description: "Look it up.", parameters: { type: "object", properties: { orderId: { type: "string" } } } },
    ]);
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup_order",
          description: "Look it up.",
          parameters: { type: "object", properties: { orderId: { type: "string" } } },
        },
      },
    ]);
  });

  it("returns undefined for no tools", () => {
    expect(buildChatTools(undefined)).toBeUndefined();
    expect(buildChatTools([])).toBeUndefined();
  });
});

describe("ToolJsonStreamSplitter", () => {
  it("extracts a tool call with nested-object args (regex-breaking case)", () => {
    const splitter = new ToolJsonStreamSplitter();
    const safe = splitter.push('{"tool":"create_ticket","args":{"meta":{"priority":"high"},"summary":"door {broken}"}}');
    expect(safe).toBe("");
    const tail = splitter.flush();
    expect(tail.text).toBe("");
    expect(tail.toolCalls).toEqual([
      { name: "create_ticket", args: { meta: { priority: "high" }, summary: "door {broken}" } },
    ]);
  });

  it("emits prose before a brace immediately and releases non-tool JSON as text", () => {
    const splitter = new ToolJsonStreamSplitter();
    expect(splitter.push("Sure, one sec. ")).toBe("Sure, one sec. ");
    splitter.push('{"note":"not a tool"}');
    const tail = splitter.flush();
    expect(tail.toolCalls).toEqual([]);
    expect(tail.text).toBe('{"note":"not a tool"}');
  });
});

describe("GroqStreamingLLMProvider", () => {
  it("throws a typed AUTH error when no apiKey is configured", async () => {
    const provider = new GroqStreamingLLMProvider({ apiKey: "" });
    const iterator = provider.stream({ input: "hi", instructions: "x", toolCalls: [], transcript: [] });
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "AUTH",
    });
  });

  it("sends native tools and parses streamed tool_calls", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup_order","arguments":"{\\"orderId\\":\\"12345\\"}"}}]}}]}',
          "data: [DONE]",
        ]),
      );
    });

    const provider = new GroqStreamingLLMProvider({ apiKey: "k", fetchImpl });
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    for await (const event of provider.stream({
      input: "track 12345",
      instructions: "Be brief.",
      toolCalls: [],
      transcript: [message("user", "track 12345")],
      tools: [{ name: "lookup_order", description: "Look it up.", parameters: { type: "object" } }],
    })) {
      if (event.type === "toolCall") {
        toolCalls.push({ name: event.name, args: event.args });
      }
    }

    expect(sentBody.tools).toBeDefined();
    expect(toolCalls).toEqual([{ name: "lookup_order", args: { orderId: "12345" } }]);
  });

  it("throws a typed error carrying the HTTP status on a 401", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("nope", { status: 401 })));
    const provider = new GroqStreamingLLMProvider({ apiKey: "bad", fetchImpl, maxRetries: 0 });
    const iterator = provider.stream({ input: "hi", instructions: "x", toolCalls: [], transcript: [message("user", "hi")] });
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "AUTH",
      status: 401,
    });
  });
});

describe("AnthropicStreamingLLMProvider", () => {
  it("requires an apiKey", async () => {
    const provider = new AnthropicStreamingLLMProvider({ apiKey: "" });
    const iterator = provider.stream({ input: "hi", instructions: "x", toolCalls: [], transcript: [] });
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(SwaramError);
  });

  it("parses text deltas and a tool_use block from the SSE stream", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On it. "}}',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"lookup_order"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"orderId\\":"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"12345\\"}"}}',
          'data: {"type":"content_block_stop","index":1}',
          'data: {"type":"message_stop"}',
        ]),
      ),
    );

    const provider = new AnthropicStreamingLLMProvider({ apiKey: "k", fetchImpl });
    const texts: string[] = [];
    const tools: Array<{ name: string; args: unknown }> = [];
    for await (const event of provider.stream({
      input: "track 12345",
      instructions: "Be brief.",
      toolCalls: [],
      transcript: [message("user", "track 12345")],
      tools: [{ name: "lookup_order", description: "Look it up.", parameters: { type: "object" } }],
    })) {
      if (event.type === "text") {
        texts.push(event.text);
      } else if (event.type === "toolCall") {
        tools.push({ name: event.name, args: event.args });
      }
    }

    expect(texts.join("")).toBe("On it. ");
    expect(tools).toEqual([{ name: "lookup_order", args: { orderId: "12345" } }]);
  });
});
