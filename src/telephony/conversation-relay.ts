/**
 * Dependency-free helpers for Twilio's ConversationRelay protocol.
 *
 * ConversationRelay does STT, TTS, and barge-in/turn-taking on Twilio's side and
 * exchanges plain text with your server over a WebSocket. This module parses the
 * messages Twilio sends, builds the messages you send back, and renders the TwiML
 * that starts a session — all as pure string/JSON functions so they can be unit
 * tested and used from any transport (the `ws` server lives in the example).
 *
 * Protocol reference: https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
 */

// ---------------------------------------------------------------------------
// Inbound: messages Twilio -> your server
// ---------------------------------------------------------------------------

export type RelaySetup = {
  type: "setup";
  sessionId: string;
  callSid: string;
  customParameters: Record<string, string>;
};

export type RelayPrompt = {
  type: "prompt";
  /** The caller's (possibly partial) transcribed speech. */
  text: string;
  /** True once Twilio considers the utterance complete. */
  last: boolean;
  lang?: string;
};

export type RelayDtmf = {
  type: "dtmf";
  digit: string;
};

export type RelayInterrupt = {
  type: "interrupt";
  /** Tokens that had already been played before the caller interrupted. */
  utteranceUntilInterrupt?: string;
};

export type RelayError = {
  type: "error";
  errorCode?: number;
  errorMessage?: string;
};

/** Any message we don't model explicitly (e.g. agentSpeaking, tokens-played). */
export type RelayUnknown = {
  type: "unknown";
  raw: Record<string, unknown>;
};

export type RelayInbound =
  | RelaySetup
  | RelayPrompt
  | RelayDtmf
  | RelayInterrupt
  | RelayError
  | RelayUnknown;

/**
 * Parse a raw WebSocket frame from ConversationRelay into a typed message.
 * Unrecognized but valid JSON becomes `{ type: "unknown", raw }`; invalid JSON
 * becomes a `RelayError` rather than throwing, so the caller never crashes on a
 * malformed frame.
 */
export function parseRelayMessage(raw: string | Buffer): RelayInbound {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { type: "error", errorMessage: "Malformed ConversationRelay frame (invalid JSON)." };
  }

  switch (data.type) {
    case "setup":
      return {
        type: "setup",
        sessionId: String(data.sessionId ?? ""),
        callSid: String(data.callSid ?? ""),
        customParameters: (data.customParameters as Record<string, string>) ?? {},
      };
    case "prompt": {
      // Twilio has used both a flat `voicePrompt` shape and a nested `payload`
      // shape across versions; accept either.
      const payload = (data.payload as Record<string, unknown>) ?? data;
      return {
        type: "prompt",
        text: String(payload.text ?? data.voicePrompt ?? ""),
        last: Boolean(payload.last ?? true),
        ...(payload.lang ? { lang: String(payload.lang) } : {}),
      };
    }
    case "dtmf":
      return { type: "dtmf", digit: String(data.digit ?? "") };
    case "interrupt":
      return {
        type: "interrupt",
        ...(data.utteranceUntilInterrupt
          ? { utteranceUntilInterrupt: String(data.utteranceUntilInterrupt) }
          : {}),
      };
    case "error":
      return {
        type: "error",
        ...(typeof data.errorCode === "number" ? { errorCode: data.errorCode } : {}),
        ...(data.errorMessage ? { errorMessage: String(data.errorMessage) } : {}),
      };
    default:
      return { type: "unknown", raw: data };
  }
}

// ---------------------------------------------------------------------------
// Outbound: messages your server -> Twilio
// ---------------------------------------------------------------------------

/**
 * Build a `text` message that Twilio will synthesize and speak. The wire format
 * is a flat `{ type, token, last }` (a string `token`, NOT an array). Stream
 * tokens by sending one per LLM chunk with `last: false`, then a final
 * `last: true` (which may be an empty token) to close the turn.
 */
export function textMessage(token: string, last = false, lang?: string) {
  return {
    type: "text" as const,
    token,
    last,
    ...(lang ? { lang } : {}),
  };
}

/** End the ConversationRelay session (hang up); optional handoff metadata. */
export function endSession(handoffData?: Record<string, unknown> | string) {
  return {
    type: "end" as const,
    ...(handoffData !== undefined
      ? { handoffData: typeof handoffData === "string" ? handoffData : JSON.stringify(handoffData) }
      : {}),
  };
}

/** Switch the STT/TTS language mid-call. */
export function switchLanguage(transcriptionLanguage: string, ttsLanguage = transcriptionLanguage) {
  return { type: "language" as const, transcriptionLanguage, ttsLanguage };
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

export type ConversationRelayTwiMLOptions = {
  /** WebSocket URL Twilio connects to. Must be wss://. */
  wsUrl: string;
  /** Spoken immediately when the call connects (the outbound greeting). */
  welcomeGreeting?: string;
  voice?: string;
  /** TTS vendor: Google | Amazon | ElevenLabs (default ElevenLabs). */
  ttsProvider?: string;
  /** STT vendor: Google | Deepgram (default Deepgram). */
  transcriptionProvider?: string;
  language?: string;
  /** What stops TTS: none | dtmf | speech | any (default speech). */
  interruptible?: string;
  /** Forwarded to your WS handler in setup.customParameters. */
  parameters?: Record<string, string>;
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the `<Response><Connect><ConversationRelay/></Connect></Response>` TwiML
 * that starts a session. Serve this from the call's voice webhook.
 */
export function buildConversationRelayTwiML(options: ConversationRelayTwiMLOptions): string {
  const attrs: Record<string, string | undefined> = {
    url: options.wsUrl,
    welcomeGreeting: options.welcomeGreeting,
    voice: options.voice,
    ttsProvider: options.ttsProvider ?? "ElevenLabs",
    transcriptionProvider: options.transcriptionProvider ?? "Deepgram",
    language: options.language ?? "en-US",
    interruptible: options.interruptible ?? "speech",
  };

  const attrString = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");

  const params = Object.entries(options.parameters ?? {})
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join("");

  const relay = params
    ? `<ConversationRelay ${attrString}>${params}</ConversationRelay>`
    : `<ConversationRelay ${attrString}/>`;

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>${relay}</Connect></Response>`;
}
