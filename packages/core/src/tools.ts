import type { ModelToolDefinition, Tool } from "./types.js";

/** 在注册时校验工具名称唯一性，并提供与模型提供方无关的工具目录。 */
export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();
  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) this.register(tool);
  }
  /** 注册一个工具；名称不合法或重复时抛出错误。 */
  register(tool: Tool): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    this.byName.set(tool.name, tool);
  }
  /** 按名称查询已注册工具。 */
  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }
  /** 导出可直接发送给模型的工具定义，隐藏执行实现。 */
  definitions(): ModelToolDefinition[] {
    return [...this.byName.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }
}
