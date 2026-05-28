import type { Unsubscribe, VADProvider } from "../../types.js";

type MicVADInstance = {
  start: () => void;
  pause: () => void;
  destroy?: () => void;
};

type VADModule = {
  MicVAD: {
    new: (options: {
      baseAssetPath?: string;
      onnxWASMBasePath?: string;
      onSpeechStart?: () => void;
      onSpeechEnd?: (audio: Float32Array) => void;
      onVADMisfire?: () => void;
    }) => Promise<MicVADInstance>;
  };
};

type BrowserVADProviderOptions = {
  loadModule?: () => Promise<VADModule>;
  baseAssetPath?: string;
  onnxWASMBasePath?: string;
};

export class BrowserVADProvider implements VADProvider {
  readonly name = "browser-vad";
  private handlers = {
    speechStart: new Set<(payload: { audio?: Float32Array; error?: Error }) => void>(),
    speechEnd: new Set<(payload: { audio?: Float32Array; error?: Error }) => void>(),
    error: new Set<(payload: { audio?: Float32Array; error?: Error }) => void>(),
  };
  private vad: MicVADInstance | null = null;

  constructor(private readonly options: BrowserVADProviderOptions = {}) {}

  isSupported() {
    return typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start() {
    if (!this.isSupported()) {
      throw new Error("Browser VAD requires microphone support.");
    }

    const module = await this.loadModule();
    this.vad = await module.MicVAD.new({
      ...(this.options.baseAssetPath ? { baseAssetPath: this.options.baseAssetPath } : {}),
      ...(this.options.onnxWASMBasePath ? { onnxWASMBasePath: this.options.onnxWASMBasePath } : {}),
      onSpeechStart: () => this.emit("speechStart", {}),
      onSpeechEnd: (audio) => this.emit("speechEnd", { audio }),
      onVADMisfire: () => undefined,
    });
    this.vad.start();
  }

  stop() {
    this.vad?.pause();
    this.vad?.destroy?.();
    this.vad = null;
  }

  on(
    event: "speechStart" | "speechEnd" | "error",
    handler: (payload: { audio?: Float32Array; error?: Error }) => void,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => {
      this.handlers[event].delete(handler);
    };
  }

  private async loadModule() {
    if (this.options.loadModule) {
      return this.options.loadModule();
    }

    return import("@ricky0123/vad-web") as Promise<VADModule>;
  }

  private emit(event: "speechStart" | "speechEnd" | "error", payload: { audio?: Float32Array; error?: Error }) {
    for (const handler of this.handlers[event]) {
      handler(payload);
    }
  }
}
