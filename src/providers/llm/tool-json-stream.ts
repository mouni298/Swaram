export function buildToolJsonSystemPrompt(instructions: string) {
  return `${instructions}

When you need a tool, emit a compact JSON block exactly like:
{"tool":"tool_name","args":{"key":"value"}}
Otherwise respond naturally and concisely.`;
}

export type ExtractedToolCall = { name: string; args: Record<string, unknown> };

function* extractToolCalls(text: string): Iterable<ExtractedToolCall> {
  const matches = text.matchAll(/\{[^{}]*"tool"\s*:\s*"([^"]+)"[^{}]*"args"\s*:\s*(\{[^{}]*\})[^{}]*\}/g);
  for (const match of matches) {
    const name = match[1];
    const argsJson = match[2];
    if (!name || !argsJson) {
      continue;
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      continue;
    }

    yield { name, args };
  }
}

/**
 * Splits a token stream into spoken prose and embedded tool-call JSON.
 * Text before the first `{` is always safe to emit; everything from a brace
 * onward is held until flush, then either parsed as a tool block (suppressed)
 * or released as prose. This avoids dropping legitimate text the way a
 * per-token "looks like JSON" heuristic does.
 */
export class ToolJsonStreamSplitter {
  private buffer = "";

  push(chunk: string): string {
    this.buffer += chunk;
    const braceIndex = this.buffer.indexOf("{");
    if (braceIndex === -1) {
      const out = this.buffer;
      this.buffer = "";
      return out;
    }

    const out = this.buffer.slice(0, braceIndex);
    this.buffer = this.buffer.slice(braceIndex);
    return out;
  }

  flush(): { text: string; toolCalls: ExtractedToolCall[] } {
    const buffer = this.buffer;
    this.buffer = "";
    if (!buffer) {
      return { text: "", toolCalls: [] };
    }

    const toolCalls = [...extractToolCalls(buffer)];
    if (toolCalls.length > 0) {
      return { text: "", toolCalls };
    }

    return { text: buffer, toolCalls: [] };
  }
}
