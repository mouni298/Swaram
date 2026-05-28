import type { STTProvider } from "../../types.js";

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
};

type SpeechRecognitionErrorEventLike = {
  error: string;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export class BrowserSTTProvider implements STTProvider {
  readonly name = "browser-stt";

  isSupported() {
    return typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  listen(options: { language?: string; signal?: AbortSignal } = {}) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      return Promise.reject(new Error("Browser speech recognition is not supported."));
    }

    return new Promise<string>((resolve, reject) => {
      const recognition = new Recognition();
      let finalTranscript = "";
      let settled = false;

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        callback();
      };

      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = options.language ?? "en-US";

      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result?.[0]?.transcript ?? "";

          if (result?.isFinal) {
            finalTranscript += text;
          }
        }
      };

      recognition.onerror = (event) => {
        settle(() => reject(new Error(`Speech recognition failed: ${event.error}`)));
      };

      recognition.onend = () => {
        settle(() => resolve(finalTranscript.trim()));
      };

      options.signal?.addEventListener(
        "abort",
        () => {
          recognition.abort();
          settle(() => reject(new Error("Speech recognition was aborted.")));
        },
        { once: true },
      );

      recognition.start();
    });
  }
}

export { BrowserSTTProvider as BrowserSpeechRecognitionProvider };
