export { SwaramError } from "./core/errors.js";
export type { SwaramErrorCode } from "./core/errors.js";
export { AudioPlaybackQueue } from "./core/audio-playback-queue.js";
export { InterruptionController } from "./core/interruption-controller.js";
export { ToolRegistry } from "./core/tool-registry.js";
export { StreamingVoiceSupportAgent } from "./core/streaming-voice-support-agent.js";
export { TextVoiceAgent } from "./core/text-voice-agent.js";
export type { TextVoiceAgentConfig, TextVoiceAgentEventMap } from "./core/text-voice-agent.js";
export { VoiceSupportAgent, VoiceAgent } from "./core/voice-support-agent.js";
export {
  parseRelayMessage,
  textMessage,
  endSession,
  switchLanguage,
  buildConversationRelayTwiML,
} from "./telephony/conversation-relay.js";
export type {
  RelayInbound,
  RelaySetup,
  RelayPrompt,
  RelayDtmf,
  RelayInterrupt,
  RelayError,
  RelayUnknown,
  ConversationRelayTwiMLOptions,
} from "./telephony/conversation-relay.js";
export { OpenAIStreamingLLMProvider } from "./providers/llm/openai-streaming-llm.js";
export { OllamaStreamingLLMProvider } from "./providers/llm/ollama-streaming-llm.js";
export { GroqStreamingLLMProvider } from "./providers/llm/groq-streaming-llm.js";
export { DeepgramStreamingSTTProvider } from "./providers/stt/deepgram-streaming-stt.js";
export { WhisperCppSTTProvider } from "./providers/stt/whisper-cpp-stt.js";
export { BrowserSTTProvider, BrowserSpeechRecognitionProvider } from "./providers/stt/browser-stt.js";
export { CartesiaStreamingTTSProvider } from "./providers/tts/cartesia-streaming-tts.js";
export { PiperTTSProvider } from "./providers/tts/piper-tts.js";
export { BrowserTTSProvider, BrowserSpeechSynthesisProvider } from "./providers/tts/browser-tts.js";
export { BrowserVADProvider } from "./providers/vad/browser-vad.js";
export { ecommerceSupportTemplate, voicePresets } from "./templates/ecommerce-support.js";
export { ecommerceSupportTools, ecommerceTools } from "./tools/ecommerce-support.js";
export {
  buildLanguageInstruction,
  getDefaultPiperVoiceForLanguage,
  getLanguageConfig,
  getPiperVoiceConfig,
  piperVoicePresets,
  supportedLanguages,
} from "./voices.js";
export type {
  AgentModelInput,
  AgentModelOutput,
  AgentModelProvider,
  AgentStatus,
  AudioChunk,
  DomainTemplate,
  LLMInput,
  LLMOutput,
  LLMProvider,
  LLMStreamEvent,
  LLMStreamInput,
  LanguageConfig,
  PlannedToolCall,
  PiperVoiceConfig,
  Role,
  STTProvider,
  STTConnectOptions,
  SpeechToTextProvider,
  StreamingAgentStatus,
  StreamingLLMProvider,
  StreamingSTTProvider,
  StreamingTTSProvider,
  StreamingVoiceSupportAgentConfig,
  StreamingVoiceSupportAgentEventMap,
  SupportAgentConfig,
  SupportTemplate,
  TTSProvider,
  TTSConnectOptions,
  TextToSpeechProvider,
  TranscriptDelta,
  ToolCall,
  ToolContext,
  ToolDefinition,
  TranscriptMessage,
  TurnResult,
  Unsubscribe,
  VoiceAgentConfig,
  VoiceAgentEventMap,
  VoiceConfig,
  VoiceSupportAgentEventMap,
  VADProvider,
  VADStartOptions,
} from "./types.js";
