import { connectFetch, throwForStatus } from "../../core/http.js";
import { ProviderEmitter } from "../../core/provider-emitter.js";
import { toSwaramError } from "../../core/errors.js";
import type { AudioChunk, StreamingSTTProvider, TranscriptDelta } from "../../types.js";

type WhisperResponse = {
  text?: string;
  transcription?: string;
};

type STTPayload = TranscriptDelta | { error: Error };
type STTEvent = "partial" | "final" | "speechFinal" | "error";

export class WhisperCppSTTProvider
  extends ProviderEmitter<STTEvent, STTPayload>
  implements StreamingSTTProvider
{
  readonly name = "whisper-cpp-stt";
  private chunks: AudioChunk[] = [];
  private closed = false;
  private signal: AbortSignal | undefined;

  constructor(
    private readonly options: {
      baseUrl?: string;
      endpoint?: string;
      model?: string;
      language?: string;
      responseFormat?: "json" | "text";
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {
    super(["partial", "final", "speechFinal", "error"]);
  }

  isSupported() {
    return typeof fetch !== "undefined" && typeof FormData !== "undefined" && typeof Blob !== "undefined";
  }

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

  private async transcribe(chunks: AudioChunk[]) {
    const url = this.url();

    try {
      const audio = await this.toBlob(chunks);
      const form = new FormData();
      form.append("file", audio, "speech.webm");
      form.append("model", this.options.model ?? "whisper.cpp");
      form.append("response_format", this.options.responseFormat ?? "json");
      if (this.options.language) {
        form.append("language", this.options.language);
      }

      const response = await connectFetch(
        url,
        { method: "POST", body: form },
        {
          fetchImpl: this.options.fetchImpl,
          ...(this.signal ? { signal: this.signal } : {}),
          ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        },
      );

      await throwForStatus(response, "whisper.cpp transcription");

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
      const normalized = toSwaramError(error, "PROVIDER_FAILURE");
      this.emit("error", { error: normalized });
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
      chunks.map((chunk) => {
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
}
