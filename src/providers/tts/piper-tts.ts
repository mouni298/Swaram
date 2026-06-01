import { connectFetch, throwForStatus } from "../../core/http.js";
import { ProviderEmitter } from "../../core/provider-emitter.js";
import { toSwaramError } from "../../core/errors.js";
import type { AudioChunk, StreamingTTSProvider, TTSConnectOptions } from "../../types.js";

type TTSPayload = AudioChunk | { error: Error };
type TTSEvent = "audio" | "start" | "end" | "error";

const EMPTY_CHUNK: AudioChunk = { data: new Uint8Array() };

export class PiperTTSProvider extends ProviderEmitter<TTSEvent, TTSPayload> implements StreamingTTSProvider {
  readonly name = "piper-tts";
  // Bumped only on stop()/close() (interruption). Every sendText within one turn
  // shares the same generation, so sequential chunks are NOT treated as stale.
  private generation = 0;
  // Serializes synthesis so audio is emitted in the same order text was sent,
  // rather than racing concurrent HTTP requests that can resolve out of order.
  private chain: Promise<void> = Promise.resolve();
  private connected = false;
  private signal: AbortSignal | undefined;

  constructor(
    private readonly options: {
      baseUrl?: string;
      endpoint?: string;
      voice?: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {
    super(["audio", "start", "end", "error"]);
  }

  isSupported() {
    return typeof fetch !== "undefined";
  }

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
    this.emit("end", EMPTY_CHUNK);
  }

  private async synthesize(text: string, generation: number) {
    if (generation !== this.generation || !this.connected) {
      return;
    }

    try {
      this.emit("start", EMPTY_CHUNK);
      const response = await connectFetch(
        this.url(),
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            ...(this.options.voice ? { "X-Piper-Voice": this.options.voice } : {}),
          },
          body: text,
        },
        {
          fetchImpl: this.options.fetchImpl,
          ...(this.signal ? { signal: this.signal } : {}),
          ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        },
      );

      await throwForStatus(response, "Piper TTS");

      const audio = await response.arrayBuffer();
      if (generation !== this.generation || !this.connected) {
        return;
      }

      this.emit("audio", {
        data: audio,
        mimeType: response.headers.get("Content-Type") ?? "audio/wav",
      });
      this.emit("end", EMPTY_CHUNK);
    } catch (error) {
      if (generation === this.generation) {
        this.emit("error", { error: toSwaramError(error, "PROVIDER_FAILURE") });
      }
    }
  }

  private url() {
    const baseUrl = this.options.baseUrl ?? "http://localhost:5000";
    return new URL(this.options.endpoint ?? "/api/tts", baseUrl).toString();
  }
}
