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

export type Role = "user" | "assistant" | "system";

export type TranscriptMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: Date;
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

export type ToolDefinition<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> = {
  name: string;
  description: string;
  run: (args: TArgs, context: ToolContext) => Promise<TResult> | TResult;
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
};

export type LLMStreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> }
  | { type: "done"; text?: string; intent?: string };

export type StreamingLLMProvider = {
  readonly name: string;
  stream: (input: LLMStreamInput, options?: { signal?: AbortSignal }) => AsyncIterable<LLMStreamEvent>;
  abort: () => void;
};

export type TTSConnectOptions = {
  voice?: VoiceConfig;
  signal?: AbortSignal;
};

export type StreamingTTSProvider = {
  readonly name: string;
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

export type SpeechToTextProvider = STTProvider;
export type TextToSpeechProvider = TTSProvider;
export type AgentModelProvider = LLMProvider;
export type AgentModelInput = LLMInput;
export type AgentModelOutput = LLMOutput;
export type DomainTemplate = SupportTemplate;
export type VoiceAgentConfig = SupportAgentConfig;
export type VoiceAgentEventMap = VoiceSupportAgentEventMap;
