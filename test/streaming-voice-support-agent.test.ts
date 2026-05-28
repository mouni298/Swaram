import { describe, expect, it, vi } from "vitest";
import {
  StreamingVoiceSupportAgent,
  ecommerceSupportTemplate,
} from "../src/index.js";
import type {
  AudioChunk,
  LLMStreamEvent,
  StreamingLLMProvider,
  StreamingSTTProvider,
  StreamingTTSProvider,
  TranscriptDelta,
  Unsubscribe,
  VADProvider,
} from "../src/index.js";

class MockVAD implements VADProvider {
  readonly name = "mock-vad";
  readonly handlers = {
    speechStart: new Set<(payload: { audio?: Float32Array; error?: Error }) => void>(),
    speechEnd: new Set<(payload: { audio?: Float32Array; error?: Error }) => void>(),
    error: new Set<(payload: { audio?: Float32Array; error?: Error }) => void>(),
  };
  start = vi.fn(() => Promise.resolve());
  stop = vi.fn();

  isSupported() {
    return true;
  }

  on(
    event: "speechStart" | "speechEnd" | "error",
    handler: (payload: { audio?: Float32Array; error?: Error }) => void,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  emit(event: "speechStart" | "speechEnd" | "error") {
    for (const handler of this.handlers[event]) {
      handler({});
    }
  }
}

class MockSTT implements StreamingSTTProvider {
  readonly name = "mock-stt";
  readonly handlers = {
    partial: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    final: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    speechFinal: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    error: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
  };
  connect = vi.fn(() => Promise.resolve());
  sendAudio = vi.fn();
  flush = vi.fn();
  close = vi.fn();

  on(
    event: "partial" | "final" | "speechFinal" | "error",
    handler: (payload: TranscriptDelta | { error: Error }) => void,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  emit(event: "partial" | "final" | "speechFinal", text: string) {
    for (const handler of this.handlers[event]) {
      handler({ text, isFinal: event !== "partial" });
    }
  }
}

class MockLLM implements StreamingLLMProvider {
  readonly name = "mock-llm";
  abort = vi.fn();

  constructor(private readonly events: LLMStreamEvent[] = [{ type: "text", text: "I can help." }]) {}

  async *stream() {
    for (const event of this.events) {
      yield event;
    }
  }
}

class MockTTS implements StreamingTTSProvider {
  readonly name = "mock-tts";
  readonly handlers = {
    audio: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    start: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    end: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    error: new Set<(payload: AudioChunk | { error: Error }) => void>(),
  };
  connect = vi.fn(() => Promise.resolve());
  sendText = vi.fn();
  flush = vi.fn();
  stop = vi.fn();
  close = vi.fn();

  on(
    event: "audio" | "start" | "end" | "error",
    handler: (payload: AudioChunk | { error: Error }) => void,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  emitAudio() {
    for (const handler of this.handlers.audio) {
      handler({ data: new Uint8Array([1, 2, 3]) });
    }
  }
}

function createStreamingAgent(events?: LLMStreamEvent[]) {
  const vad = new MockVAD();
  const stt = new MockSTT();
  const llm = new MockLLM(events);
  const tts = new MockTTS();
  const agent = new StreamingVoiceSupportAgent({
    template: ecommerceSupportTemplate,
    vad,
    stt,
    llm,
    tts,
  });

  return { agent, vad, stt, llm, tts };
}

describe("StreamingVoiceSupportAgent", () => {
  it("starts providers and moves to listening", async () => {
    const { agent, vad, stt, tts } = createStreamingAgent();

    await agent.start();

    expect(vad.start).toHaveBeenCalledOnce();
    expect(stt.connect).toHaveBeenCalledOnce();
    expect(tts.connect).toHaveBeenCalledOnce();
    expect(agent.getStatus()).toBe("listening");
  });

  it("maps VAD and STT events to SDK events", async () => {
    const { agent, vad, stt } = createStreamingAgent();
    const events: string[] = [];
    agent.on("speechStart", () => events.push("speechStart"));
    agent.on("speechEnd", () => events.push("speechEnd"));
    agent.on("partialTranscript", ({ text }) => events.push(`partial:${text}`));
    agent.on("finalTranscript", ({ text }) => events.push(`final:${text}`));

    await agent.start();
    vad.emit("speechStart");
    stt.emit("partial", "Where is");
    vad.emit("speechEnd");
    stt.emit("final", "Where is my order?");

    expect(events).toEqual([
      "speechStart",
      "partial:Where is",
      "speechEnd",
      "final:Where is my order?",
    ]);
  });

  it("starts LLM and TTS after speech final", async () => {
    const { agent, stt, tts } = createStreamingAgent([{ type: "text", text: "Sure. " }]);

    await agent.start();
    stt.emit("speechFinal", "Where is my order?");
    await expect.poll(() => tts.sendText.mock.calls.length).toBe(1);

    expect(tts.sendText).toHaveBeenCalledWith("Sure. ");
    expect(tts.flush).toHaveBeenCalledOnce();
    expect(agent.getTranscript().at(-1)?.role).toBe("assistant");
  });

  it("emits interruption and aborts streams when user speaks during assistant speech", async () => {
    const { agent, vad, llm, tts } = createStreamingAgent();
    const interruptions: string[] = [];
    agent.on("interruption", ({ reason }) => interruptions.push(reason));

    await agent.start();
    agent["events"].emit("status", { status: "speaking" });
    agent["playback"].enqueue({ data: new Uint8Array([1]) });
    agent["status"] = "speaking";
    vad.emit("speechStart");

    expect(interruptions).toContain("barge_in");
    expect(llm.abort).toHaveBeenCalledOnce();
    expect(tts.stop).toHaveBeenCalledOnce();
  });

  it("executes tool calls from streaming LLM events", async () => {
    const { agent, stt } = createStreamingAgent([
      { type: "toolCall", name: "lookup_order", args: { orderId: "12345" } },
      { type: "text", text: "I found the order. " },
    ]);

    await agent.start();
    stt.emit("speechFinal", "Where is my order 12345?");
    await expect.poll(() => agent.getToolCalls().length).toBe(1);

    expect(agent.getToolCalls()[0]?.name).toBe("lookup_order");
  });

  it("stops providers and allows restart after STT errors", async () => {
    const { agent, vad, stt, tts } = createStreamingAgent();
    const errors: string[] = [];
    agent.on("error", ({ error }) => errors.push(error.message));

    await agent.start();

    for (const handler of stt.handlers.error) {
      handler({ error: new Error("Whisper.cpp unavailable") });
    }

    expect(agent.getStatus()).toBe("error");
    expect(errors).toEqual(["Whisper.cpp unavailable"]);
    expect(vad.stop).toHaveBeenCalledOnce();
    expect(stt.close).toHaveBeenCalledOnce();
    expect(tts.stop).toHaveBeenCalledOnce();
    expect(tts.close).toHaveBeenCalledOnce();

    await agent.start();
    expect(agent.getStatus()).toBe("listening");
  });
});
