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
    const status = this.dependencies.getStatus();
    // Interrupt whenever the agent is mid-response: forming a reply ("thinking"),
    // streaming text ("speaking"), or still playing audio. The status flips to
    // "listening" once the LLM stream ends, but playback continues for seconds
    // afterward, so gate on playback activity too — not just the status.
    const responding = status === "thinking" || status === "speaking";
    if (!responding && !this.dependencies.playback.isActive()) {
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
