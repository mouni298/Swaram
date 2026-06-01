import { describe, expect, it } from "vitest";
import {
  buildConversationRelayTwiML,
  endSession,
  parseRelayMessage,
  switchLanguage,
  textMessage,
} from "../src/index.js";

describe("parseRelayMessage", () => {
  it("parses a setup message with custom parameters", () => {
    const msg = parseRelayMessage(
      JSON.stringify({
        type: "setup",
        sessionId: "VX123",
        callSid: "CA123",
        customParameters: { cfgId: "abc" },
      }),
    );
    expect(msg).toEqual({
      type: "setup",
      sessionId: "VX123",
      callSid: "CA123",
      customParameters: { cfgId: "abc" },
    });
  });

  it("parses a nested-payload prompt", () => {
    const msg = parseRelayMessage(
      JSON.stringify({ type: "prompt", payload: { text: "where is my order", last: true, lang: "en-US" } }),
    );
    expect(msg).toEqual({ type: "prompt", text: "where is my order", last: true, lang: "en-US" });
  });

  it("parses a flat voicePrompt prompt", () => {
    const msg = parseRelayMessage(JSON.stringify({ type: "prompt", voicePrompt: "hello" }));
    expect(msg).toMatchObject({ type: "prompt", text: "hello", last: true });
  });

  it("parses dtmf and interrupt", () => {
    expect(parseRelayMessage(JSON.stringify({ type: "dtmf", digit: "1" }))).toEqual({ type: "dtmf", digit: "1" });
    expect(parseRelayMessage(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "our hours" }))).toEqual({
      type: "interrupt",
      utteranceUntilInterrupt: "our hours",
    });
  });

  it("returns an error message for malformed JSON instead of throwing", () => {
    const msg = parseRelayMessage("{not json");
    expect(msg.type).toBe("error");
  });

  it("classifies unmodeled types as unknown", () => {
    const msg = parseRelayMessage(JSON.stringify({ type: "agentSpeaking", sequenceNumber: 3 }));
    expect(msg.type).toBe("unknown");
  });
});

describe("outbound message builders", () => {
  it("builds streaming and final text messages (flat token field)", () => {
    expect(textMessage("Hello", false)).toEqual({ type: "text", token: "Hello", last: false });
    expect(textMessage("", true)).toEqual({ type: "text", token: "", last: true });
    expect(textMessage("Hola", true, "es-ES")).toEqual({ type: "text", token: "Hola", last: true, lang: "es-ES" });
  });

  it("builds an end message with stringified handoff data", () => {
    expect(endSession({ reason: "done" })).toEqual({ type: "end", handoffData: '{"reason":"done"}' });
    expect(endSession()).toEqual({ type: "end" });
  });

  it("builds a language switch", () => {
    expect(switchLanguage("sv-SE")).toEqual({
      type: "language",
      transcriptionLanguage: "sv-SE",
      ttsLanguage: "sv-SE",
    });
  });
});

describe("buildConversationRelayTwiML", () => {
  it("renders Connect/ConversationRelay with defaults and escapes the greeting", () => {
    const twiml = buildConversationRelayTwiML({
      wsUrl: "wss://example.ngrok.app/relay",
      welcomeGreeting: 'Hi & "welcome"',
      voice: "en-US-Journey-O",
      parameters: { cfgId: "abc" },
    });

    expect(twiml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain('url="wss://example.ngrok.app/relay"');
    expect(twiml).toContain('ttsProvider="ElevenLabs"');
    expect(twiml).toContain('transcriptionProvider="Deepgram"');
    expect(twiml).toContain('interruptible="speech"');
    expect(twiml).toContain("Hi &amp; &quot;welcome&quot;");
    expect(twiml).toContain('<Parameter name="cfgId" value="abc"/>');
  });

  it("self-closes when there are no parameters", () => {
    const twiml = buildConversationRelayTwiML({ wsUrl: "wss://x/relay" });
    expect(twiml).toContain("<ConversationRelay ");
    expect(twiml).toContain("/></Connect></Response>");
  });
});
