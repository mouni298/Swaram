import type { AudioChunk, StreamingTTSProvider, TTSConnectOptions, Unsubscribe } from "../../types.js";

export class PiperTTSProvider implements StreamingTTSProvider {
  readonly name = "piper-tts";
  private requestId = 0;
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

    const id = ++this.requestId;
    void this.synthesize(text, id);
  }

  flush() {
    // Piper HTTP synthesis is request based; each sendText call is already flushed.
  }

  stop() {
    this.requestId += 1;
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

  private async synthesize(text: string, id: number) {
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
        throw new Error(`Piper TTS failed with status ${response.status}.`);
      }

      const audio = await response.arrayBuffer();
      if (id !== this.requestId || !this.connected) {
        return;
      }

      this.emit("audio", {
        data: audio,
        mimeType: response.headers.get("Content-Type") ?? "audio/wav",
      });
      this.emit("end", new Uint8Array());
    } catch (error) {
      if (id === this.requestId) {
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
