import { describe, expect, it } from "vitest";
import {
  buildLanguageInstruction,
  getDefaultPiperVoiceForLanguage,
  getPiperVoiceConfig,
  piperVoicePresets,
  supportedLanguages,
} from "../src/index.js";

describe("voice catalog", () => {
  it("exports English, Hindi, and Telugu language configs", () => {
    expect(supportedLanguages.map((language) => language.id)).toEqual(["en-US", "en-GB", "hi-IN", "te-IN"]);
    expect(buildLanguageInstruction("hi-IN")).toContain("Hindi");
    expect(buildLanguageInstruction("te-IN")).toContain("Telugu");
  });

  it("exports Piper voice metadata with model and config URLs", () => {
    expect(piperVoicePresets.length).toBeGreaterThanOrEqual(10);

    for (const voice of piperVoicePresets) {
      expect(voice.modelFile).toBe(`${voice.id}.onnx`);
      expect(voice.modelUrl).toContain(voice.modelFile);
      expect(voice.configUrl).toBe(`${voice.modelUrl}.json`);
    }
  });

  it("finds default Piper voices by language", () => {
    expect(getDefaultPiperVoiceForLanguage("hi-IN")?.id).toBe("hi_IN-priyamvada-medium");
    expect(getDefaultPiperVoiceForLanguage("te-IN")?.id).toBe("te_IN-maya-medium");
    expect(getPiperVoiceConfig("te_IN-venkatesh-medium")?.language).toBe("te-IN");
  });
});
