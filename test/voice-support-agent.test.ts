import { describe, expect, it, vi } from "vitest";
import {
  SwaramError,
  VoiceSupportAgent,
  ecommerceSupportTemplate,
} from "../src/index.js";
import type { LLMInput, LLMOutput, LLMProvider, STTProvider, TTSProvider, ToolDefinition } from "../src/index.js";

class FixedSTT implements STTProvider {
  readonly name = "fixed-stt";

  constructor(private text: string) {}

  isSupported() {
    return true;
  }

  listen() {
    return Promise.resolve(this.text);
  }
}

class SilentTTS implements TTSProvider {
  readonly name = "silent-tts";
  readonly speak = vi.fn(() => Promise.resolve());

  isSupported() {
    return true;
  }
}

class TestSupportModel implements LLMProvider {
  readonly name = "test-support-model";

  generate(input: LLMInput): LLMOutput {
    const orderId = input.input.match(/\b(\d{4,})\b/)?.[1] ?? null;

    if (input.input.toLowerCase().includes("order")) {
      return orderId
        ? {
            intent: "order_tracking",
            text: `I will check order ${orderId}.`,
            toolCalls: [{ name: "lookup_order", args: { orderId } }],
          }
        : {
            intent: "order_tracking",
            text: "I can check that. Please share your order ID.",
          };
    }

    return {
      intent: "general_support",
      text: "I will create a support ticket.",
      toolCalls: [
        {
          name: "create_support_ticket",
          args: {
            summary: input.input,
            priority: input.input.toLowerCase().includes("terrible") ? "high" : "normal",
          },
        },
      ],
    };
  }
}

function createAgent(overrides: Partial<ConstructorParameters<typeof VoiceSupportAgent>[0]> = {}) {
  const tts = new SilentTTS();
  const agent = new VoiceSupportAgent({
    template: ecommerceSupportTemplate,
    stt: new FixedSTT("Where is my order 12345?"),
    llm: new TestSupportModel(),
    tts,
    ...overrides,
  });

  return { agent, tts };
}

describe("VoiceSupportAgent", () => {
  it("runs a text turn and appends user and assistant messages", async () => {
    const { agent } = createAgent();

    const result = await agent.sendText("Where is my order 12345?");

    expect(result.intent).toBe("order_tracking");
    expect(agent.getTranscript().map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("calls STT, LLM, tools, and TTS during startTurn", async () => {
    const { agent, tts } = createAgent();

    const result = await agent.startTurn();

    expect(result.toolCalls[0]?.name).toBe("lookup_order");
    expect(tts.speak).toHaveBeenCalledOnce();
    expect(agent.getStatus()).toBe("idle");
  });

  it("emits tool call events with results", async () => {
    const { agent } = createAgent();
    const toolCalls: string[] = [];

    agent.on("toolCall", ({ toolCall }) => {
      toolCalls.push(toolCall.name);
    });

    await agent.sendText("Where is my order 12345?");

    expect(toolCalls).toEqual(["lookup_order"]);
    expect(agent.getToolCalls()[0]?.result).toMatchObject({ orderId: "12345" });
  });

  it("throws a typed error for empty input", async () => {
    const { agent } = createAgent();

    await expect(agent.sendText(" ")).rejects.toMatchObject({
      code: "EMPTY_INPUT",
    });
  });

  it("throws a typed error for unknown tools", async () => {
    const missingToolModel: LLMProvider = {
      name: "missing-tool-model",
      generate: () => ({
        text: "I will do that.",
        toolCalls: [{ name: "missing_tool", args: {} }],
      }),
    };
    const { agent } = createAgent({ llm: missingToolModel, tools: [] });

    await expect(agent.sendText("Call the missing tool")).rejects.toMatchObject({
      code: "UNKNOWN_TOOL",
    });
  });

  it("prevents concurrent turns", async () => {
    let resolveListen: (value: string) => void = () => undefined;
    const slowStt: STTProvider = {
      name: "slow-stt",
      isSupported: () => true,
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    };
    const { agent } = createAgent({ stt: slowStt });

    const firstTurn = agent.startTurn();

    expect(() => agent.startTurn()).toThrow(SwaramError);

    resolveListen("Where is my order 12345?");
    await firstTurn;
  });

  it("passes tool context into custom tools", async () => {
    const customTool: ToolDefinition = {
      name: "create_support_ticket",
      description: "Create a custom ticket.",
      run: (_args, context) => ({
        sessionId: context.sessionId,
        messageCount: context.transcript.length,
      }),
    };
    const agent = new VoiceSupportAgent({
      instructions: "You are a generic support agent.",
      stt: new FixedSTT("This is terrible"),
      llm: new TestSupportModel(),
      tts: new SilentTTS(),
      tools: [customTool],
    });

    await agent.sendText("This is terrible");

    expect(agent.getToolCalls()[0]?.result).toMatchObject({ messageCount: 2 });
  });
});
