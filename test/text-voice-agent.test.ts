import { describe, expect, it, vi } from "vitest";
import { TextVoiceAgent, ecommerceSupportTemplate } from "../src/index.js";
import type { LLMStreamEvent, StreamingLLMProvider } from "../src/index.js";

class MockLLM implements StreamingLLMProvider {
  readonly name = "mock-llm";
  abort = vi.fn();

  constructor(private readonly events: LLMStreamEvent[] = [{ type: "text", text: "I can help." }]) {}

  async *stream(_input: unknown, options?: { signal?: AbortSignal }) {
    for (const event of this.events) {
      if (options?.signal?.aborted) {
        return;
      }
      yield event;
    }
  }
}

// An LLM that returns a different scripted set of events on each call, modelling
// real function calling: round 1 emits a tool call, round 2 the grounded answer.
class ScriptedLLM implements StreamingLLMProvider {
  readonly name = "scripted-llm";
  abort = vi.fn();
  private call = 0;

  constructor(private readonly rounds: LLMStreamEvent[][]) {}

  async *stream() {
    const events = this.rounds[this.call] ?? [];
    this.call += 1;
    for (const event of events) {
      yield event;
    }
  }
}

// An LLM that never finishes until aborted, to exercise interruption.
class HangingLLM implements StreamingLLMProvider {
  readonly name = "hanging-llm";
  abort = vi.fn();

  async *stream(_input: unknown, options?: { signal?: AbortSignal }): AsyncGenerator<LLMStreamEvent> {
    yield { type: "text", text: "thinking" };
    await new Promise<void>((resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }
}

describe("TextVoiceAgent", () => {
  it("seeds the transcript with the system instructions", () => {
    const agent = new TextVoiceAgent({ instructions: "Be brief.", llm: new MockLLM() });
    expect(agent.getTranscript()).toHaveLength(1);
    expect(agent.getTranscript()[0]).toMatchObject({ role: "system", content: "Be brief." });
  });

  it("streams tokens and commits user + assistant transcript", async () => {
    const agent = new TextVoiceAgent({
      instructions: "Be brief.",
      llm: new MockLLM([
        { type: "text", text: "Hello " },
        { type: "text", text: "there." },
      ]),
    });
    const tokens: string[] = [];
    agent.on("token", ({ text }) => tokens.push(text));

    const reply = await agent.handlePrompt("hi");

    expect(tokens).toEqual(["Hello ", "there."]);
    expect(reply).toBe("Hello there.");
    const roles = agent.getTranscript().map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant"]);
    expect(agent.getTranscript().at(-1)?.content).toBe("Hello there.");
  });

  it("runs tools and never emits tool JSON as tokens", async () => {
    const agent = new TextVoiceAgent({
      template: ecommerceSupportTemplate,
      llm: new ScriptedLLM([
        [{ type: "toolCall", name: "lookup_order", args: { orderId: "12345" } }],
        [{ type: "text", text: "Your order is on the way." }],
      ]),
    });
    const tokens: string[] = [];
    const toolNames: string[] = [];
    agent.on("token", ({ text }) => tokens.push(text));
    agent.on("toolCall", ({ toolCall }) => toolNames.push(toolCall.name));

    const reply = await agent.handlePrompt("where is order 12345");

    expect(toolNames).toEqual(["lookup_order"]);
    expect(tokens).toEqual(["Your order is on the way."]);
    expect(reply).toBe("Your order is on the way.");
    expect(agent.getToolCalls()).toHaveLength(1);
    // The tool result was fed back into the transcript before the grounded reply.
    expect(agent.getTranscript().map((m) => m.role)).toEqual(["system", "user", "tool", "assistant"]);
  });

  it("aborts the in-flight reply on interrupt", async () => {
    const agent = new TextVoiceAgent({ instructions: "Be brief.", llm: new HangingLLM() });
    const turn = agent.handlePrompt("hello");
    // Let the first token flow, then barge in.
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.isResponding()).toBe(true);
    agent.interrupt();

    await expect(turn).resolves.toBe("thinking");
    expect(agent.isResponding()).toBe(false);
  });

  it("emits an error event and rethrows when the LLM fails", async () => {
    const failing: StreamingLLMProvider = {
      name: "failing-llm",
      abort: vi.fn(),
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("Groq down");
      },
    };
    const agent = new TextVoiceAgent({ instructions: "x", llm: failing });
    const errors: string[] = [];
    agent.on("error", ({ error }) => errors.push(error.message));

    await expect(agent.handlePrompt("hi")).rejects.toThrow("Groq down");
    expect(errors).toEqual(["Groq down"]);
    expect(agent.isResponding()).toBe(false);
  });
});
