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
      // Silero VAD tuning (forwarded as-is to @ricky0123/vad-web).
      positiveSpeechThreshold?: number;
      negativeSpeechThreshold?: number;
      minSpeechFrames?: number;
      redemptionFrames?: number;
      preSpeechPadFrames?: number;
      // Custom microphone stream lifecycle. Lets callers feed a processed
      // stream (e.g. RNNoise-denoised) into the VAD instead of a raw mic.
      getStream?: () => Promise<MediaStream>;
      pauseStream?: (stream: MediaStream) => Promise<void> | void;
      resumeStream?: (stream: MediaStream) => Promise<MediaStream>;
    }) => Promise<MicVADInstance>;
  };
};

type BrowserVADProviderOptions = {
  loadModule?: () => Promise<VADModule>;
  baseAssetPath?: string;
  onnxWASMBasePath?: string;
  /** Min speech probability (0-1) to start a segment. Higher = less noise-triggered. */
  positiveSpeechThreshold?: number;
  /** Probability below which speech is considered ended. */
  negativeSpeechThreshold?: number;
  /** Min frames (~32ms each) a segment must last to count as speech, not a misfire. */
  minSpeechFrames?: number;
  /** Frames of sub-threshold audio tolerated before declaring speech end. */
  redemptionFrames?: number;
  /** Frames of audio kept before speech onset so the first word isn't clipped. */
  preSpeechPadFrames?: number;
  /**
   * Provide the microphone MediaStream. Use this to insert audio processing
   * (e.g. an RNNoise denoiser worklet) between the mic and the VAD — the same
   * processed stream then feeds STT in utterance ("vad") mode.
   */
  getStream?: () => Promise<MediaStream>;
  /** Tear down the stream from getStream when the VAD pauses/stops. */
  pauseStream?: (stream: MediaStream) => Promise<void> | void;
  /** Rebuild the stream when the VAD resumes. */
  resumeStream?: (stream: MediaStream) => Promise<MediaStream>;
  /** Called when a too-short segment is discarded as noise (a "misfire"). */
  onMisfire?: () => void;
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

    const o = this.options;
    const module = await this.loadModule();
    this.vad = await module.MicVAD.new({
      ...(o.baseAssetPath ? { baseAssetPath: o.baseAssetPath } : {}),
      ...(o.onnxWASMBasePath ? { onnxWASMBasePath: o.onnxWASMBasePath } : {}),
      ...(o.positiveSpeechThreshold !== undefined ? { positiveSpeechThreshold: o.positiveSpeechThreshold } : {}),
      ...(o.negativeSpeechThreshold !== undefined ? { negativeSpeechThreshold: o.negativeSpeechThreshold } : {}),
      ...(o.minSpeechFrames !== undefined ? { minSpeechFrames: o.minSpeechFrames } : {}),
      ...(o.redemptionFrames !== undefined ? { redemptionFrames: o.redemptionFrames } : {}),
      ...(o.preSpeechPadFrames !== undefined ? { preSpeechPadFrames: o.preSpeechPadFrames } : {}),
      ...(o.getStream ? { getStream: o.getStream } : {}),
      ...(o.pauseStream ? { pauseStream: o.pauseStream } : {}),
      ...(o.resumeStream ? { resumeStream: o.resumeStream } : {}),
      onSpeechStart: () => this.emit("speechStart", {}),
      onSpeechEnd: (audio) => this.emit("speechEnd", { audio }),
      onVADMisfire: () => o.onMisfire?.(),
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
