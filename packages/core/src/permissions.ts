import type { PermissionPolicy, PermissionPolicyResult, PermissionRule, PermissionStore, Tool } from "./types.js";

/** 安全默认策略：读取操作直接放行，所有改状态或外部操作均请求确认。 */
export class DefaultPermissionPolicy implements PermissionPolicy {
  /** 根据风险等级和未过期规则决定放行、拒绝或请求确认。 */
  async evaluate({
    tool,
    rules,
  }: {
    tool: Tool;
    call: unknown;
    workspace?: string;
    rules: PermissionRule[];
  }): Promise<PermissionPolicyResult> {
    if (tool.risk === "read") return { type: "allow" };
    const now = Date.now();
    if (rules.some((rule) => rule.tool === tool.name && rule.risk === tool.risk && Date.parse(rule.expiresAt) > now))
      return { type: "allow" };
    return { type: "ask" };
  }
}

/** 确定性的内存规则存储，适用于 CLI、测试及嵌入式宿主。 */
export class InMemoryPermissionStore implements PermissionStore {
  private readonly rules = new Map<string, PermissionRule>();
  /** 校验并写入一条权限规则。 */
  async createRule(rule: PermissionRule) {
    validatePermissionRule(rule);
    this.rules.set(rule.id, rule);
    return rule;
  }
  /** 返回仍有效且符合可选筛选条件的规则。 */
  async listRules(filter?: { workspace?: string; tool?: string }) {
    const now = Date.now();
    return [...this.rules.values()].filter(
      (rule) =>
        Date.parse(rule.expiresAt) > now &&
        (!filter?.tool || rule.tool === filter.tool) &&
        (!filter?.workspace || rule.scope.workspace === filter.workspace),
    );
  }
  /** 撤销指定标识的规则；不存在时不报错。 */
  async revokeRule(id: string) {
    this.rules.delete(id);
  }
}

/** 持久化规则前必须执行的基础安全校验。 */
export function validatePermissionRule(rule: PermissionRule): void {
  if (
    !rule.id ||
    !rule.tool ||
    !Number.isFinite(Date.parse(rule.expiresAt)) ||
    Date.parse(rule.expiresAt) <= Date.now()
  )
    throw new Error("Permission rule must have an identifier, tool, and future expiry");
  const scope = rule.scope;
  const hasNarrowScope = Boolean(scope.pathPrefix || scope.executable || scope.argsPrefix?.length);
  if (!hasNarrowScope) throw new Error("Permission rule requires a path or argv scope");
  if (scope.pathPrefix === "/" || scope.pathPrefix === "*" || scope.executable === "*")
    throw new Error("Permission rule scope is too broad");
  if (scope.argsPrefix?.some((arg) => arg === "*"))
    throw new Error("Permission rule argv scope may not contain wildcards");
}
