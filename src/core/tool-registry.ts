import { SwaramError } from "./errors.js";
import type { ToolContext, ToolDefinition } from "../types.js";

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

  async run(name: string, args: Record<string, unknown>, context: ToolContext) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new SwaramError("UNKNOWN_TOOL", `Tool "${name}" is not registered.`);
    }

    return tool.run(args, context);
  }
}
