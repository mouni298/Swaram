import type { LanguageConfig, PiperVoiceConfig, VoiceConfig } from "./types.js";

const piperVoiceBaseUrl = "https://huggingface.co/rhasspy/piper-voices/resolve";

function piperVoice(
  id: string,
  label: string,
  language: string,
  path: string,
  options: Pick<VoiceConfig, "rate" | "pitch"> = {},
): PiperVoiceConfig {
  const modelFile = `${id}.onnx`;
  const basePath = `${piperVoiceBaseUrl}/${path}/${modelFile}`;

  return {
    id,
    label,
    language,
    modelFile,
    modelUrl: basePath,
    configUrl: `${basePath}.json`,
    ...options,
  };
}

export const supportedLanguages: LanguageConfig[] = [
  {
    id: "en-US",
    label: "English, US",
    instruction: "Respond in English.",
  },
  {
    id: "en-GB",
    label: "English, UK",
    instruction: "Respond in English.",
  },
  {
    id: "hi-IN",
    label: "Hindi, India",
    instruction: "Respond in Hindi using Devanagari script.",
  },
  {
    id: "te-IN",
    label: "Telugu, India",
    instruction: "Respond in Telugu using Telugu script.",
  },
];

export const piperVoicePresets: PiperVoiceConfig[] = [
  piperVoice("en_US-lessac-medium", "US female - Lessac", "en-US", "v1.0.0/en/en_US/lessac/medium", {
    rate: 0.95,
    pitch: 1.02,
  }),
  piperVoice("en_US-amy-medium", "US female - Amy", "en-US", "v1.0.0/en/en_US/amy/medium"),
  piperVoice("en_US-ryan-medium", "US male - Ryan", "en-US", "v1.0.0/en/en_US/ryan/medium", {
    rate: 0.98,
    pitch: 0.92,
  }),
  piperVoice("en_GB-alba-medium", "UK female - Alba", "en-GB", "v1.0.0/en/en_GB/alba/medium", {
    pitch: 1.03,
  }),
  piperVoice(
    "en_GB-northern_english_male-medium",
    "UK male - Northern English",
    "en-GB",
    "v1.0.0/en/en_GB/northern_english_male/medium",
    {
      rate: 0.98,
      pitch: 0.94,
    },
  ),
  piperVoice("hi_IN-priyamvada-medium", "Hindi female - Priyamvada", "hi-IN", "main/hi/hi_IN/priyamvada/medium"),
  piperVoice("hi_IN-pratham-medium", "Hindi male - Pratham", "hi-IN", "main/hi/hi_IN/pratham/medium", {
    rate: 0.98,
    pitch: 0.95,
  }),
  piperVoice("te_IN-maya-medium", "Telugu female - Maya", "te-IN", "main/te/te_IN/maya/medium"),
  piperVoice("te_IN-padmavathi-medium", "Telugu female - Padmavathi", "te-IN", "main/te/te_IN/padmavathi/medium"),
  piperVoice("te_IN-venkatesh-medium", "Telugu male - Venkatesh", "te-IN", "main/te/te_IN/venkatesh/medium", {
    rate: 0.98,
    pitch: 0.95,
  }),
];

export function getLanguageConfig(languageId: string) {
  return supportedLanguages.find((language) => language.id === languageId);
}

export function getPiperVoiceConfig(voiceId: string) {
  return piperVoicePresets.find((voice) => voice.id === voiceId);
}

export function getDefaultPiperVoiceForLanguage(languageId: string) {
  return piperVoicePresets.find((voice) => voice.language === languageId) ?? piperVoicePresets[0];
}

export function buildLanguageInstruction(languageId: string) {
  return getLanguageConfig(languageId)?.instruction ?? supportedLanguages[0]?.instruction ?? "Respond in English.";
}

