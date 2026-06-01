export type AgentStatus = "idle" | "listening" | "thinking" | "speaking" | "stopped" | "error";

export type StreamingAgentStatus =
  | "idle"
  | "listening"
  | "user_speaking"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "stopped"
  | "error";

export type Role = "user" | "assistant" | "system" | "tool";

export type TranscriptMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: Date;
  /** For `tool` messages: the name of the tool whose result this carries. */
  name?: string;
};

export type VoiceConfig = {
  id: string;
  label?: string;
  language?: string;
  rate?: number;
  pitch?: number;
};

export type LanguageConfig = {
  id: string;
  label: string;
  instruction: string;
};

export type PiperVoiceConfig = VoiceConfig & {
  id: string;
  label: string;
  language: string;
  modelFile: string;
  modelUrl: string;
  configUrl: string;
};

export type SupportTemplate = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools?: ToolDefinition[];
  starterPrompts?: string[];
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  createdAt: Date;
};

export type ToolContext = {
  sessionId: string;
  transcript: TranscriptMessage[];
  instructions: string;
};

/**
 * JSON Schema describing a tool's arguments, advertised to the model for native
 * function calling. Use a standard object schema, e.g.
 * `{ type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] }`.
 */
export type ToolParameterSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolDefinition<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> = {
  name: string;
  description: string;
  /**
   * JSON Schema for the tool's arguments. When present, the tool is advertised
   * to the model via the provider's native function-calling API. When absent,
   * providers fall back to a prompt-based JSON convention.
   */
  parameters?: ToolParameterSchema;
  run: (args: TArgs, context: ToolContext) => Promise<TResult> | TResult;
};

/** A tool advertised to an LLM provider for native function calling. */
export type ToolSchema = {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
};

export type STTProvider = {
  readonly name: string;
  isSupported: () => boolean;
  listen: (options?: { language?: string; signal?: AbortSignal }) => Promise<string>;
};

export type TTSProvider = {
  readonly name: string;
  isSupported: () => boolean;
  speak: (text: string, options?: { voice?: VoiceConfig; signal?: AbortSignal }) => Promise<void>;
  stop?: () => void;
};

export type LLMInput = {
  input: string;
  transcript: TranscriptMessage[];
  instructions: string;
  toolCalls: ToolCall[];
  /** Tools the model may call, advertised for native function calling. */
  tools?: ToolSchema[];
};

export type PlannedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type LLMOutput = {
  text: string;
  intent?: string;
  toolCalls?: PlannedToolCall[];
};

export type LLMProvider = {
  readonly name: string;
  generate: (input: LLMInput) => Promise<LLMOutput> | LLMOutput;
};

export type SupportAgentConfig = {
  instructions?: string;
  template?: SupportTemplate;
  voice?: VoiceConfig;
  stt: STTProvider;
  llm: LLMProvider;
  tts: TTSProvider;
  tools?: ToolDefinition[];
};

export type TurnResult = {
  message: TranscriptMessage;
  intent?: string;
  toolCalls: ToolCall[];
};

export type VoiceSupportAgentEventMap = {
  status: { status: AgentStatus };
  transcript: { message: TranscriptMessage; transcript: TranscriptMessage[] };
  toolCall: { toolCall: ToolCall };
  error: { error: Error };
};

export type Unsubscribe = () => void;

export type AudioChunk = {
  data: ArrayBuffer | Uint8Array | Blob;
  mimeType?: string;
  sampleRate?: number;
};

export type TranscriptDelta = {
  text: string;
  isFinal: boolean;
};

export type VADStartOptions = {
  signal?: AbortSignal;
};

export type VADProvider = {
  readonly name: string;
  isSupported: () => boolean;
  start: (options?: VADStartOptions) => Promise<void>;
  stop: () => Promise<void> | void;
  on: (
    event: "speechStart" | "speechEnd" | "error",
    handler: (payload: { audio?: Float32Array; error?: Error }) => void,
  ) => Unsubscribe;
};

export type STTConnectOptions = {
  language?: string;
  signal?: AbortSignal;
};

export type StreamingSTTProvider = {
  readonly name: string;
  /** Optional capability check, mirroring the non-streaming providers. */
  isSupported?: () => boolean;
  connect: (options?: STTConnectOptions) => Promise<void>;
  sendAudio: (chunk: AudioChunk) => void;
  flush: () => void;
  close: () => Promise<void> | void;
  on: (
    event: "partial" | "final" | "speechFinal" | "error",
    handler: (payload: TranscriptDelta | { error: Error }) => void,
  ) => Unsubscribe;
};

export type LLMStreamInput = {
  input: string;
  transcript: TranscriptMessage[];
  instructions: string;
  toolCalls: ToolCall[];
  /** Tools the model may call, advertised for native function calling. */
  tools?: ToolSchema[];
};

export type LLMStreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> }
  | { type: "done"; text?: string; intent?: string };

export type StreamingLLMProvider = {
  readonly name: string;
  /** Optional capability check, mirroring the non-streaming providers. */
  isSupported?: () => boolean;
  stream: (input: LLMStreamInput, options?: { signal?: AbortSignal }) => AsyncIterable<LLMStreamEvent>;
  abort: () => void;
};

export type TTSConnectOptions = {
  voice?: VoiceConfig;
  signal?: AbortSignal;
};

export type StreamingTTSProvider = {
  readonly name: string;
  /** Optional capability check, mirroring the non-streaming providers. */
  isSupported?: () => boolean;
  connect: (options?: TTSConnectOptions) => Promise<void>;
  sendText: (text: string) => void;
  flush: () => void;
  stop: () => void;
  close: () => Promise<void> | void;
  on: (
    event: "audio" | "start" | "end" | "error",
    handler: (payload: AudioChunk | { error: Error }) => void,
  ) => Unsubscribe;
};

export type StreamingVoiceSupportAgentConfig = {
  instructions?: string;
  template?: SupportTemplate;
  voice?: VoiceConfig;
  vad: VADProvider;
  stt: StreamingSTTProvider;
  llm: StreamingLLMProvider;
  tts: StreamingTTSProvider;
  tools?: ToolDefinition[];
  mediaStream?: MediaStream;
  /**
   * Where utterance audio for the STT comes from.
   * - "mediaRecorder" (default): a continuous MediaRecorder streams webm chunks.
   *   Right for socket-streaming STT providers (e.g. Deepgram).
   * - "vad": each utterance's PCM from the VAD is encoded to a standalone WAV and
   *   sent on speech-end. Right for utterance-based STT (e.g. whisper.cpp), and
   *   avoids the headerless-webm problem on turns after the first.
   */
  sttAudioSource?: "mediaRecorder" | "vad";
  /** Sample rate of the VAD's Float32 audio. @ricky0123/vad-web emits 16000. */
  vadSampleRate?: number;
};

export type StreamingVoiceSupportAgentEventMap = {
  status: { status: StreamingAgentStatus };
  speechStart: Record<string, never>;
  speechEnd: Record<string, never>;
  partialTranscript: { text: string };
  finalTranscript: { text: string };
  interruption: { reason: "barge_in" | "manual" };
  llmToken: { text: string };
  audioStart: Record<string, never>;
  audioEnd: Record<string, never>;
  transcript: { message: TranscriptMessage; transcript: TranscriptMessage[] };
  toolCall: { toolCall: ToolCall };
  error: { error: Error };
};

/** @deprecated Use {@link STTProvider}. */
export type SpeechToTextProvider = STTProvider;
/** @deprecated Use {@link TTSProvider}. */
export type TextToSpeechProvider = TTSProvider;
/** @deprecated Use {@link LLMProvider}. */
export type AgentModelProvider = LLMProvider;
/** @deprecated Use {@link LLMInput}. */
export type AgentModelInput = LLMInput;
/** @deprecated Use {@link LLMOutput}. */
export type AgentModelOutput = LLMOutput;
/** @deprecated Use {@link SupportTemplate}. */
export type DomainTemplate = SupportTemplate;
/** @deprecated Use {@link SupportAgentConfig}. */
export type VoiceAgentConfig = SupportAgentConfig;
/** @deprecated Use {@link VoiceSupportAgentEventMap}. */
export type VoiceAgentEventMap = VoiceSupportAgentEventMap;
