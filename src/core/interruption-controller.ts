import type { AudioPlaybackQueue } from "./audio-playback-queue.js";
import type { StreamingAgentStatus, StreamingLLMProvider, StreamingTTSProvider } from "../types.js";

export class InterruptionController {
  constructor(
    private readonly dependencies: {
      getStatus: () => StreamingAgentStatus;
      setInterrupted: (reason: "barge_in" | "manual") => void;
      llm: StreamingLLMProvider;
      tts: StreamingTTSProvider;
      playback: AudioPlaybackQueue;
    },
  ) {}

  handleSpeechStart() {
    if (this.dependencies.getStatus() !== "speaking") {
      return false;
    }

    this.tearDown("barge_in");
    return true;
  }

  interruptManually() {
    this.tearDown("manual");
  }

  private tearDown(reason: "barge_in" | "manual") {
    this.dependencies.llm.abort();
    this.dependencies.tts.stop();
    this.dependencies.playback.clear();
    this.dependencies.setInterrupted(reason);
  }
}
