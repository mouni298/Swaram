export function buildToolJsonSystemPrompt(instructions: string) {
  return `${instructions}

When you need a tool, emit a compact JSON block exactly like:
{"tool":"tool_name","args":{"key":"value"}}
Otherwise respond naturally and concisely.`;
}

export type ExtractedToolCall = { name: string; args: Record<string, unknown> };

/**
 * Scan `text` for balanced `{...}` blocks, accounting for nested braces and
 * braces inside string literals, and yield those that parse as a tool call
 * (`{ "tool": "...", "args": {...} }`). Unlike a flat regex, this handles nested
 * argument objects and brace characters inside string values.
 */
function* extractToolCalls(text: string): Iterable<ExtractedToolCall> {
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) {
      return;
    }

    const end = matchingBrace(text, start);
    if (end === -1) {
      return;
    }

    const candidate = text.slice(start, end + 1);
    index = end + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Not a complete JSON object on its own; advance past this brace and retry.
      index = start + 1;
      continue;
    }

    if (parsed && typeof parsed === "object" && "tool" in parsed && "args" in parsed) {
      const { tool, args } = parsed as { tool: unknown; args: unknown };
      if (typeof tool === "string" && args && typeof args === "object") {
        yield { name: tool, args: args as Record<string, unknown> };
      }
    }
  }
}

/** Index of the `}` that closes the `{` at `open`, or -1. String-aware. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
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
