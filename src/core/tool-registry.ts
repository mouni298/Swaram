import { SwaramError } from "./errors.js";
import type { ToolContext, ToolDefinition, ToolSchema } from "../types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
      throw new SwaramError("DUPLICATE_TOOL", `Tool "${tool.name}" is already registered.`);
    }

    this.tools.set(tool.name, tool);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  list() {
    return Array.from(this.tools.values());
  }

  /**
   * Tool schemas to advertise to a model for native function calling. Tools that
   * didn't declare `parameters` are advertised with an empty object schema.
   * Returns undefined when there are no tools, so callers can omit the field.
   */
  schemas(): ToolSchema[] | undefined {
    if (this.tools.size === 0) {
      return undefined;
    }

    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object" },
    }));
  }

  async run(name: string, args: Record<string, unknown>, context: ToolContext) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new SwaramError("UNKNOWN_TOOL", `Tool "${name}" is not registered.`);
    }

    return tool.run(args, context);
  }
}
