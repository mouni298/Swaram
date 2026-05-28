import type { TTSProvider, VoiceConfig } from "../../types.js";

export class BrowserTTSProvider implements TTSProvider {
  readonly name = "browser-tts";

  isSupported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  speak(text: string, options: { voice?: VoiceConfig; signal?: AbortSignal } = {}) {
    if (!this.isSupported()) {
      return Promise.reject(new Error("Browser speech synthesis is not supported."));
    }

    return new Promise<void>((resolve, reject) => {
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options.voice?.language ?? "en-US";
      utterance.rate = options.voice?.rate ?? 1;
      utterance.pitch = options.voice?.pitch ?? 1;

      const voices = window.speechSynthesis.getVoices();
      const languagePrefix = (options.voice?.language ?? "en").slice(0, 2).toLowerCase();
      const preferredVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith(languagePrefix));

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("Speech synthesis failed."));

      options.signal?.addEventListener(
        "abort",
        () => {
          window.speechSynthesis.cancel();
          reject(new Error("Speech synthesis was aborted."));
        },
        { once: true },
      );

      window.speechSynthesis.speak(utterance);
    });
  }

  stop() {
    if (this.isSupported()) {
      window.speechSynthesis.cancel();
    }
  }
}

export { BrowserTTSProvider as BrowserSpeechSynthesisProvider };
