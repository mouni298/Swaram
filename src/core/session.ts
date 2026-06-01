import type { Role, ToolCall, TranscriptMessage } from "../types.js";

/** Cap the tool-call -> result -> re-prompt loop so a misbehaving model can't spin forever. */
export const MAX_TOOL_ROUNDS = 4;

/**
 * Render a tool result for a model that doesn't get the result via a native
 * tool_call_id round-trip. Shared by every LLM provider's transcript serializer
 * so the wire format stays identical across providers.
 */
export function toolResultText(name: string | undefined, content: string): string {
  return `Tool result (${name ?? "tool"}): ${content}`;
}

/** The latest user-authored message in a transcript, newest-first. */
export function latestUserText(transcript: TranscriptMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i]?.role === "user") {
      return transcript[i]?.content ?? "";
    }
  }
  return "";
}

/** A stable-ish unique id; uses crypto.randomUUID when available. */
export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `swaram_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

export function createMessage(role: Role, content: string, name?: string): TranscriptMessage {
  return {
    id: createId(),
    role,
    content,
    createdAt: new Date(),
    ...(name ? { name } : {}),
  };
}

export function createToolCall(name: string, args: Record<string, unknown>, result?: unknown): ToolCall {
  return {
    id: createId(),
    name,
    args,
    result,
    createdAt: new Date(),
  };
}
