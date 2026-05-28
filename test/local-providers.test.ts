import { describe, expect, it, vi } from "vitest";
import {
  OllamaStreamingLLMProvider,
  PiperTTSProvider,
  WhisperCppSTTProvider,
} from "../src/index.js";
import type { AudioChunk, TranscriptDelta } from "../src/index.js";

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(lines: string[]) {
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
    { status: 200 },
  );
}

describe("local open-source providers", () => {
  it("WhisperCppSTTProvider posts audio and emits final transcript", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ text: "hello world" })));
    const provider = new WhisperCppSTTProvider({ baseUrl: "http://localhost:2022", fetchImpl });
    const finals: string[] = [];

    provider.on("final", (payload) => {
      finals.push((payload as TranscriptDelta).text);
    });

    await provider.connect();
    provider.sendAudio({ data: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" });
    provider.flush();
    await expect.poll(() => finals.length).toBe(1);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(finals).toEqual(["hello world"]);
  });

  it("OllamaStreamingLLMProvider streams text deltas", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([
          JSON.stringify({ message: { content: "Hello " } }),
          JSON.stringify({ message: { content: "there." }, done: true }),
        ]),
      ),
    );
    const provider = new OllamaStreamingLLMProvider({ fetchImpl });
    const tokens: string[] = [];

    for await (const event of provider.stream({
      input: "hi",
      transcript: [],
      instructions: "Be concise.",
      toolCalls: [],
    })) {
      if (event.type === "text") {
        tokens.push(event.text);
      }
    }

    expect(tokens).toEqual(["Hello ", "there."]);
  });

  it("OllamaStreamingLLMProvider parses JSON tool call blocks", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([
          JSON.stringify({
            message: {
              content: '{"tool":"lookup_order","args":{"orderId":"12345"}}',
            },
          }),
        ]),
      ),
    );
    const provider = new OllamaStreamingLLMProvider({ fetchImpl });
    const toolCalls: string[] = [];

    for await (const event of provider.stream({
      input: "track order 12345",
      transcript: [],
      instructions: "Use tools.",
      toolCalls: [],
    })) {
      if (event.type === "toolCall") {
        toolCalls.push(event.name);
      }
    }

    expect(toolCalls).toEqual(["lookup_order"]);
  });

  it("PiperTTSProvider emits WAV audio and ignores stale responses after stop", async () => {
    let resolveResponse: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const provider = new PiperTTSProvider({ fetchImpl });
    const audio: AudioChunk[] = [];
    provider.on("audio", (payload) => {
      if ("data" in payload) {
        audio.push(payload);
      }
    });

    await provider.connect();
    provider.sendText("hello");
    provider.stop();
    resolveResponse(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(audio).toEqual([]);
  });
});
