import type { AudioChunk } from "../types.js";

export class AudioPlaybackQueue {
  private queue: AudioChunk[] = [];
  private playing = false;
  private stopped = false;
  private context: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;

  constructor(
    private readonly hooks: {
      onStart?: () => void;
      onEnd?: () => void;
      onError?: (error: Error) => void;
    } = {},
  ) {}

  enqueue(chunk: AudioChunk) {
    this.queue.push(chunk);
    void this.drain();
  }

  /** True while audio is actively playing or queued — used to gate barge-in. */
  isActive() {
    return this.playing || this.queue.length > 0;
  }

  clear() {
    this.queue = [];
    this.currentSource?.stop();
    this.currentSource = null;
    this.playing = false;
    this.stopped = true;
  }

  async close() {
    this.clear();
    await this.context?.close();
    this.context = null;
  }

  private async drain() {
    if (this.playing) {
      return;
    }

    this.stopped = false;
    this.playing = true;
    this.hooks.onStart?.();

    try {
      while (this.queue.length > 0 && !this.stopped) {
        const chunk = this.queue.shift();
        if (chunk) {
          await this.playChunk(chunk);
        }
      }
    } catch (error) {
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.playing = false;
      this.hooks.onEnd?.();
    }
  }

  private async playChunk(chunk: AudioChunk) {
    if (typeof window === "undefined" || !("AudioContext" in window)) {
      return;
    }

    this.context ??= new AudioContext();
    const buffer = await this.toArrayBuffer(chunk.data);
    const audioBuffer = await this.context.decodeAudioData(buffer.slice(0));

    await new Promise<void>((resolve, reject) => {
      const source = this.context?.createBufferSource();
      if (!source || !this.context) {
        resolve();
        return;
      }

      this.currentSource = source;
      source.buffer = audioBuffer;
      source.connect(this.context.destination);
      source.onended = () => resolve();

      try {
        source.start();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async toArrayBuffer(data: AudioChunk["data"]) {
    if (data instanceof ArrayBuffer) {
      return data;
    }

    if (data instanceof Uint8Array) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    return data.arrayBuffer();
  }
}
