import type { AudioChunk, StreamingTTSProvider, TTSConnectOptions, Unsubscribe } from "../../types.js";

type WebSocketLike = {
  binaryType?: BinaryType;
  readyState: number;
  send: (data: string | ArrayBuffer | Blob | Uint8Array) => void;
  close: () => void;
  addEventListener: (event: "open" | "message" | "error" | "close", handler: (event: Event | MessageEvent) => void) => void;
};

export class CartesiaStreamingTTSProvider implements StreamingTTSProvider {
  readonly name = "cartesia-streaming-tts";
  private socket: WebSocketLike | null = null;
  private handlers = {
    audio: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    start: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    end: new Set<(payload: AudioChunk | { error: Error }) => void>(),
    error: new Set<(payload: AudioChunk | { error: Error }) => void>(),
  };

  constructor(
    private readonly options: {
      apiKey: string;
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
  ) {}

  connect(options: TTSConnectOptions = {}) {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      const socket = this.options.createWebSocket ? this.options.createWebSocket(url) : new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.emit("start", new Uint8Array());
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event as MessageEvent));
      socket.addEventListener("error", () => {
        const error = new Error("Cartesia streaming TTS connection failed.");
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

  private buildUrl() {
    const url = new URL(this.options.url ?? "wss://api.cartesia.ai/tts/websocket");
    url.searchParams.set("api_key", this.options.apiKey);
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
        this.emit("error", { error: new Error(parsed.error) });
      } else if (parsed.done || parsed.type === "done") {
        this.emit("end", new Uint8Array());
      }
    }
  }

  private emit(event: "audio" | "start" | "end" | "error", payload: AudioChunk | { error: Error } | Uint8Array) {
    const normalized = payload instanceof Uint8Array ? { data: payload } : payload;
    for (const handler of this.handlers[event]) {
      handler(normalized);
    }
  }
}
