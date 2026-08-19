import type { ModelToolDefinition, Tool } from "./types.js";

/** Validates unique names once and exposes a provider-neutral tool catalogue. */
export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();
  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) this.register(tool);
  }
  register(tool: Tool): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name))
      throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.byName.has(tool.name))
      throw new Error(`Duplicate tool name: ${tool.name}`);
    this.byName.set(tool.name, tool);
  }
  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }
  definitions(): ModelToolDefinition[] {
    return [...this.byName.values()].map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    );
  }
}
