import type { AudioChunk, StreamingSTTProvider, TranscriptDelta, Unsubscribe } from "../../types.js";

type WebSocketLike = {
  binaryType?: BinaryType;
  readyState: number;
  send: (data: string | ArrayBuffer | Blob | Uint8Array) => void;
  close: () => void;
  addEventListener: (event: "open" | "message" | "error" | "close", handler: (event: Event | MessageEvent) => void) => void;
};

type DeepgramResult = {
  type?: string;
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
};

export class DeepgramStreamingSTTProvider implements StreamingSTTProvider {
  readonly name = "deepgram-streaming-stt";
  private socket: WebSocketLike | null = null;
  private handlers = {
    partial: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    final: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    speechFinal: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    error: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
  };

  constructor(
    private readonly options: {
      apiKey: string;
      model?: string;
      language?: string;
      endpointing?: number;
      smartFormat?: boolean;
      url?: string;
      createWebSocket?: (url: string, protocols?: string[]) => WebSocketLike;
    },
  ) {}

  connect(options: { language?: string; signal?: AbortSignal } = {}) {
    const url = this.buildUrl(options.language);

    return new Promise<void>((resolve, reject) => {
      const socket = this.options.createWebSocket
        ? this.options.createWebSocket(url, ["token", this.options.apiKey])
        : new WebSocket(url, ["token", this.options.apiKey]);

      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.addEventListener("open", () => resolve());
      socket.addEventListener("message", (event) => this.handleMessage(event as MessageEvent));
      socket.addEventListener("error", () => {
        const error = new Error("Deepgram streaming STT connection failed.");
        this.emit("error", { error });
        reject(error);
      });

      options.signal?.addEventListener(
        "abort",
        () => {
          this.close();
        },
        { once: true },
      );
    });
  }

  sendAudio(chunk: AudioChunk) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(chunk.data);
  }

  flush() {
    this.socket?.send(JSON.stringify({ type: "Finalize" }));
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }

  on(
    event: "partial" | "final" | "speechFinal" | "error",
    handler: (payload: TranscriptDelta | { error: Error }) => void,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => {
      this.handlers[event].delete(handler);
    };
  }

  private buildUrl(language?: string) {
    const url = new URL(this.options.url ?? "wss://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.options.model ?? "nova-3");
    url.searchParams.set("language", language ?? this.options.language ?? "en-US");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("endpointing", String(this.options.endpointing ?? 300));
    url.searchParams.set("smart_format", String(this.options.smartFormat ?? true));
    return url.toString();
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") {
      return;
    }

    let data: DeepgramResult;
    try {
      data = JSON.parse(event.data) as DeepgramResult;
    } catch {
      return;
    }

    const text = data.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (!text) {
      return;
    }

    if (data.is_final) {
      this.emit("final", { text, isFinal: true });
    } else {
      this.emit("partial", { text, isFinal: false });
    }

    if (data.speech_final) {
      this.emit("speechFinal", { text, isFinal: true });
    }
  }

  private emit(event: "partial" | "final" | "speechFinal" | "error", payload: TranscriptDelta | { error: Error }) {
    for (const handler of this.handlers[event]) {
      handler(payload);
    }
  }
}
