import { ProviderEmitter } from "../../core/provider-emitter.js";
import { readEnv } from "../../core/env.js";
import { SwaramError } from "../../core/errors.js";
import type { AudioChunk, StreamingTTSProvider, TTSConnectOptions } from "../../types.js";

type WebSocketLike = {
  binaryType?: BinaryType;
  readyState: number;
  send: (data: string | ArrayBuffer | Blob | Uint8Array) => void;
  close: () => void;
  addEventListener: (event: "open" | "message" | "error" | "close", handler: (event: Event | MessageEvent) => void) => void;
};

type TTSPayload = AudioChunk | { error: Error };
type TTSEvent = "audio" | "start" | "end" | "error";

const EMPTY_CHUNK: AudioChunk = { data: new Uint8Array() };

export class CartesiaStreamingTTSProvider
  extends ProviderEmitter<TTSEvent, TTSPayload>
  implements StreamingTTSProvider
{
  readonly name = "cartesia-streaming-tts";
  private readonly apiKey: string;
  private socket: WebSocketLike | null = null;

  constructor(
    private readonly options: {
      apiKey?: string;
      voiceId: string;
      modelId?: string;
      url?: string;
      outputFormat?: {
        container?: string;
        encoding?: string;
        sampleRate?: number;
      };
      createWebSocket?: (url: string) => WebSocketLike;
    },
  ) {
    super(["audio", "start", "end", "error"]);
    this.apiKey = options.apiKey ?? readEnv("CARTESIA_API_KEY") ?? "";
  }

  isSupported() {
    return Boolean(this.apiKey) && (Boolean(this.options.createWebSocket) || typeof WebSocket !== "undefined");
  }

  connect(options: TTSConnectOptions = {}) {
    if (!this.apiKey) {
      return Promise.reject(
        new SwaramError("AUTH", "CartesiaStreamingTTSProvider requires an apiKey (or set CARTESIA_API_KEY)."),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      const socket = this.options.createWebSocket ? this.options.createWebSocket(url) : new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.emit("start", EMPTY_CHUNK);
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event as MessageEvent));
      socket.addEventListener("error", () => {
        const error = new SwaramError("PROVIDER_FAILURE", "Cartesia streaming TTS connection failed.");
        this.emit("error", { error });
        reject(error);
      });

      options.signal?.addEventListener(
        "abort",
        () => {
          this.stop();
        },
        { once: true },
      );
    });
  }

  sendText(text: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        model_id: this.options.modelId ?? "sonic-3",
        transcript: text,
        voice: { mode: "id", id: this.options.voiceId },
        output_format: {
          container: this.options.outputFormat?.container ?? "raw",
          encoding: this.options.outputFormat?.encoding ?? "pcm_f32le",
          sample_rate: this.options.outputFormat?.sampleRate ?? 44100,
        },
        continue: true,
      }),
    );
  }

  flush() {
    this.socket?.send(JSON.stringify({ continue: false }));
  }

  stop() {
    this.socket?.send(JSON.stringify({ cancel: true }));
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.emit("end", EMPTY_CHUNK);
  }

  private buildUrl() {
    const url = new URL(this.options.url ?? "wss://api.cartesia.ai/tts/websocket");
    url.searchParams.set("api_key", this.apiKey);
    return url.toString();
  }

  private handleMessage(event: MessageEvent) {
    if (event.data instanceof ArrayBuffer) {
      this.emit("audio", { data: event.data });
      return;
    }

    if (event.data instanceof Blob) {
      this.emit("audio", { data: event.data });
      return;
    }

    if (typeof event.data === "string") {
      let parsed: { type?: string; data?: string; done?: boolean; error?: string };
      try {
        parsed = JSON.parse(event.data) as { type?: string; data?: string; done?: boolean; error?: string };
      } catch {
        return;
      }

      if (parsed.error) {
        this.emit("error", { error: new SwaramError("PROVIDER_FAILURE", parsed.error) });
      } else if (parsed.done || parsed.type === "done") {
        this.emit("end", EMPTY_CHUNK);
      }
    }
  }
}
