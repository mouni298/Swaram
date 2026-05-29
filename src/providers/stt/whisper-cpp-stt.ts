import type { AudioChunk, StreamingSTTProvider, TranscriptDelta, Unsubscribe } from "../../types.js";

type WhisperResponse = {
  text?: string;
  transcription?: string;
};

export class WhisperCppSTTProvider implements StreamingSTTProvider {
  readonly name = "whisper-cpp-stt";
  private chunks: AudioChunk[] = [];
  private closed = false;
  private signal: AbortSignal | undefined;
  private handlers = {
    partial: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    final: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    speechFinal: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
    error: new Set<(payload: TranscriptDelta | { error: Error }) => void>(),
  };

  constructor(
    private readonly options: {
      baseUrl?: string;
      endpoint?: string;
      model?: string;
      language?: string;
      responseFormat?: "json" | "text";
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  connect(options: { language?: string; signal?: AbortSignal } = {}) {
    this.closed = false;
    this.signal = options.signal;
    this.chunks = [];
    return Promise.resolve();
  }

  sendAudio(chunk: AudioChunk) {
    if (!this.closed) {
      this.chunks.push(chunk);
    }
  }

  flush() {
    const chunks = this.chunks;
    this.chunks = [];
    if (chunks.length === 0 || this.closed) {
      return;
    }

    void this.transcribe(chunks);
  }

  close() {
    this.closed = true;
    this.chunks = [];
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

  private async transcribe(chunks: AudioChunk[]) {
    const url = this.url();

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const audio = await this.toBlob(chunks);
      const form = new FormData();
      form.append("file", audio, "speech.webm");
      form.append("model", this.options.model ?? "whisper.cpp");
      form.append("response_format", this.options.responseFormat ?? "json");
      if (this.options.language) {
        form.append("language", this.options.language);
      }

      const response = await fetchImpl(url, {
        method: "POST",
        body: form,
        ...(this.signal ? { signal: this.signal } : {}),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `whisper.cpp transcription failed with status ${response.status}.${detail ? ` ${detail}` : ""}`,
        );
      }

      const text =
        this.options.responseFormat === "text"
          ? await response.text()
          : this.readJsonText((await response.json()) as WhisperResponse);
      const cleanText = text.trim();
      if (!cleanText) {
        return;
      }

      this.emit("final", { text: cleanText, isFinal: true });
      this.emit("speechFinal", { text: cleanText, isFinal: true });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const message =
        normalized.name === "AbortError"
          ? normalized.message
          : `Whisper.cpp transcription request failed at ${url}: ${normalized.message}`;

      this.emit("error", {
        error: new Error(message),
      });
    }
  }

  private url() {
    const baseUrl = this.options.baseUrl ?? "http://localhost:2022";
    return new URL(this.options.endpoint ?? "/v1/audio/transcriptions", baseUrl).toString();
  }

  private readJsonText(response: WhisperResponse) {
    return response.text ?? response.transcription ?? "";
  }

  private async toBlob(chunks: AudioChunk[]) {
    const parts = await Promise.all(
      chunks.map(async (chunk) => {
        if (chunk.data instanceof Blob) {
          return chunk.data;
        }

        if (chunk.data instanceof Uint8Array) {
          return new Blob([chunk.data], { type: chunk.mimeType ?? "audio/webm" });
        }

        return new Blob([chunk.data], { type: chunk.mimeType ?? "audio/webm" });
      }),
    );

    return new Blob(parts, { type: chunks[0]?.mimeType ?? "audio/webm" });
  }

  private emit(event: "partial" | "final" | "speechFinal" | "error", payload: TranscriptDelta | { error: Error }) {
    for (const handler of this.handlers[event]) {
      handler(payload);
    }
  }
}
