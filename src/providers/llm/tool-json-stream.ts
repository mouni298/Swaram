export function buildToolJsonSystemPrompt(instructions: string) {
  return `${instructions}

When you need a tool, emit a compact JSON block exactly like:
{"tool":"tool_name","args":{"key":"value"}}
Otherwise respond naturally and concisely.`;
}

export type ExtractedToolCall = { name: string; args: Record<string, unknown> };

// Textual tool-call markers various models emit in the *content* stream instead
// of the structured tool_calls field: e.g. Llama 3.x / gpt-oss / Llama 4 on
// Groq emit `<function=name>{...}`, Hermes/Qwen emit `<tool_call>{...}`. We hold
// text back from any of these (or a `{`) and convert them to real tool calls so
// they're never spoken.
const TAG_MARKERS = ["<function=", "<tool_call>", "<|python_tag|>"];
const FUNCTION_TAG = /^<function=\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*>/;

/**
 * Coerce a parsed JSON object into a tool call if it looks like one. Handles the
 * SDK convention (`{tool, args}`) and the common native shapes models emit as
 * text (`{name, arguments}` / `{name, parameters}`).
 */
function asToolCall(parsed: unknown): ExtractedToolCall | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.tool === "string" && obj.args && typeof obj.args === "object") {
    return { name: obj.tool, args: obj.args as Record<string, unknown> };
  }

  if (typeof obj.name === "string") {
    const args = obj.arguments ?? obj.parameters;
    if (args === undefined) {
      return { name: obj.name, args: {} };
    }
    if (args && typeof args === "object") {
      return { name: obj.name, args: args as Record<string, unknown> };
    }
  }

  return null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Walk a buffer, pulling out tool calls (both `{...}` JSON and `<function=…>`/
 * `<tool_call>` markup) and returning the surrounding prose. Tool-call spans are
 * removed from the returned text so nothing model-internal is spoken.
 */
function extractFromBuffer(buffer: string): { text: string; toolCalls: ExtractedToolCall[] } {
  let text = "";
  const toolCalls: ExtractedToolCall[] = [];
  let i = 0;

  while (i < buffer.length) {
    const rest = buffer.slice(i);

    // <function=NAME>{ args } [</function>]
    const fn = rest.match(FUNCTION_TAG);
    if (fn) {
      const braceStart = buffer.indexOf("{", i + fn[0].length - 1);
      const braceEnd = braceStart === -1 ? -1 : matchingBrace(buffer, braceStart);
      if (braceEnd === -1) {
        break; // incomplete tool markup — drop the trailing fragment
      }
      toolCalls.push({ name: fn[1] as string, args: (tryParse(buffer.slice(braceStart, braceEnd + 1)) as Record<string, unknown>) ?? {} });
      i = braceEnd + 1;
      if (buffer.slice(i).startsWith("</function>")) {
        i += "</function>".length;
      }
      continue;
    }

    // <tool_call>{ name, arguments }</tool_call>  (also bare <|python_tag|>{...})
    if (rest.startsWith("<tool_call>") || rest.startsWith("<|python_tag|>")) {
      const braceStart = buffer.indexOf("{", i);
      const braceEnd = braceStart === -1 ? -1 : matchingBrace(buffer, braceStart);
      if (braceEnd === -1) {
        break;
      }
      const call = asToolCall(tryParse(buffer.slice(braceStart, braceEnd + 1)));
      if (call) {
        toolCalls.push(call);
      }
      i = braceEnd + 1;
      if (buffer.slice(i).startsWith("</tool_call>")) {
        i += "</tool_call>".length;
      }
      continue;
    }

    // A JSON object: a tool call (suppressed) or ordinary text (released).
    if (buffer[i] === "{") {
      const braceEnd = matchingBrace(buffer, i);
      if (braceEnd === -1) {
        text += rest; // unbalanced; not tool markup
        break;
      }
      const span = buffer.slice(i, braceEnd + 1);
      const call = asToolCall(tryParse(span));
      if (call) {
        toolCalls.push(call);
      } else {
        text += span;
      }
      i = braceEnd + 1;
      continue;
    }

    text += buffer[i];
    i += 1;
  }

  return { text, toolCalls };
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
 * The earliest index in `buffer` that could begin a tool-call marker — a `{`, or
 * a tag marker (or a partial tag marker at the very end, so we wait for the rest
 * of it rather than speaking half a `<function=` tag).
 */
function firstMarkerIndex(buffer: string): number {
  let earliest = buffer.indexOf("{");

  for (const marker of TAG_MARKERS) {
    const full = buffer.indexOf(marker);
    if (full !== -1 && (earliest === -1 || full < earliest)) {
      earliest = full;
    }
  }

  // A trailing partial marker (e.g. buffer ends with "<func"): hold from there.
  for (const marker of TAG_MARKERS) {
    for (let k = Math.min(marker.length - 1, buffer.length); k >= 1; k -= 1) {
      if (buffer.endsWith(marker.slice(0, k))) {
        const pos = buffer.length - k;
        if (earliest === -1 || pos < earliest) {
          earliest = pos;
        }
        break;
      }
    }
  }

  return earliest;
}

/**
 * Splits a token stream into spoken prose and embedded tool calls. Text before
 * the first tool-call marker (`{`, `<function=`, `<tool_call>`, `<|python_tag|>`)
 * is safe to emit; everything from a marker onward is held until flush, then
 * parsed as tool call(s) (suppressed) or released as prose. This keeps model
 * tool-call syntax — in any of the common formats — from being spoken aloud.
 */
export class ToolJsonStreamSplitter {
  private buffer = "";

  push(chunk: string): string {
    this.buffer += chunk;
    const markerIndex = firstMarkerIndex(this.buffer);
    if (markerIndex === -1) {
      const out = this.buffer;
      this.buffer = "";
      return out;
    }

    const out = this.buffer.slice(0, markerIndex);
    this.buffer = this.buffer.slice(markerIndex);
    return out;
  }

  flush(): { text: string; toolCalls: ExtractedToolCall[] } {
    const buffer = this.buffer;
    this.buffer = "";
    if (!buffer) {
      return { text: "", toolCalls: [] };
    }

    return extractFromBuffer(buffer);
  }
}
