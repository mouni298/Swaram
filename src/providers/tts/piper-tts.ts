import type { AudioChunk, StreamingTTSProvider, TTSConnectOptions, Unsubscribe } from "../../types.js";

export class PiperTTSProvider implements StreamingTTSProvider {
  readonly name = "piper-tts";
  // Bumped only on stop()/close() (interruption). Every sendText within one turn
  // shares the same generation, so sequential chunks are NOT treated as stale.
  private generation = 0;
  // Serializes synthesis so audio is emitted in the same order text was sent,
  // rather than racing concurrent HTTP requests that can resolve out of order.
  private chain: Promise<void> = Promise.resolve();
  private connected = false;
  private signal: AbortSignal | undefined;
  private handlers = {
    audio: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    start: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    end: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    error: new Set<(payload: AudioChunk | { error: Error }) => void>(),
  };

  constructor(
    private readonly options: {
      baseUrl?: string;
      endpoint?: string;
      voice?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  connect(options: TTSConnectOptions = {}) {
    this.connected = true;
    this.signal = options.signal;
    return Promise.resolve();
  }

  sendText(text: string) {
    if (!this.connected || !text.trim()) {
      return;
    }

    const generation = this.generation;
    this.chain = this.chain.then(() => this.synthesize(text, generation));
  }

  flush() {
    // Piper HTTP synthesis is request based; each sendText call is already flushed.
  }

  stop() {
    this.generation += 1;
    this.chain = Promise.resolve();
  }

  close() {
    this.connected = false;
    this.stop();
    this.emit("end", new Uint8Array());
  }

  on(
    event: "audio" | "start" | "end" | "error",
    handler: (payload: AudioChunk | { error: Error }) => void,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => {
      this.handlers[event].delete(handler);
    };
  }

  private async synthesize(text: string, generation: number) {
    if (generation !== this.generation || !this.connected) {
      return;
    }

    try {
      this.emit("start", new Uint8Array());
      const response = await (this.options.fetchImpl ?? fetch)(this.url(), {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          ...(this.options.voice ? { "X-Piper-Voice": this.options.voice } : {}),
        },
        body: text,
        ...(this.signal ? { signal: this.signal } : {}),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Piper TTS failed with status ${response.status}.${detail ? ` ${detail}` : ""}`);
      }

      const audio = await response.arrayBuffer();
      if (generation !== this.generation || !this.connected) {
        return;
      }

      this.emit("audio", {
        data: audio,
        mimeType: response.headers.get("Content-Type") ?? "audio/wav",
      });
      this.emit("end", new Uint8Array());
    } catch (error) {
      if (generation === this.generation) {
        this.emit("error", {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  private url() {
    const baseUrl = this.options.baseUrl ?? "http://localhost:5000";
    return new URL(this.options.endpoint ?? "/api/tts", baseUrl).toString();
  }

  private emit(event: "audio" | "start" | "end" | "error", payload: AudioChunk | { error: Error } | Uint8Array) {
    const normalized = payload instanceof Uint8Array ? { data: payload } : payload;
    for (const handler of this.handlers[event]) {
      handler(normalized);
    }
  }
}
