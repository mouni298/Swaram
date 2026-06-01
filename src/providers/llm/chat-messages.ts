import { toolResultText } from "../../core/session.js";
import type { LLMStreamInput, ToolSchema, TranscriptMessage } from "../../types.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** An OpenAI-style function tool, as sent to Groq / OpenAI-compatible APIs. */
export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Serialize the conversation for an OpenAI-compatible chat API.
 *
 * The agent has already appended the latest user turn (and any tool-result
 * turns) to `transcript`, so messages are built from `transcript` alone — the
 * separate `input` field is used only as a fallback when there is no
 * conversational history (e.g. a provider called directly in a test). This
 * avoids the previous bug where the latest user message was sent twice.
 *
 * `tool`-role transcript entries are surfaced to the model as system context
 * (`Tool result (name): ...`), which every OpenAI-compatible backend accepts
 * without the strict assistant-tool_calls/tool_call_id round-trip.
 */
export function buildChatMessages(input: LLMStreamInput, systemPrompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  const history = input.transcript.filter((message) => message.role !== "system");
  for (const message of history) {
    messages.push(serializeMessage(message));
  }

  const hasUserTurn = history.some((message) => message.role === "user");
  if (!hasUserTurn && input.input) {
    messages.push({ role: "user", content: input.input });
  }

  return messages;
}

function serializeMessage(message: TranscriptMessage): ChatMessage {
  if (message.role === "tool") {
    return {
      role: "system",
      content: toolResultText(message.name, message.content),
    };
  }

  return { role: message.role, content: message.content };
}

/** Map the SDK tool schemas to the OpenAI-style `tools` array, or undefined. */
export function buildChatTools(tools: ToolSchema[] | undefined): ChatTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
